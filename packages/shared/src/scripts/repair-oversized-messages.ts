import type { UIMessage } from "ai";
import { eq, sql } from "drizzle-orm";
import db from "../db";
import { aiMessages } from "../db/schema";
import { uploadSessionFile } from "../lib/chatbot-session-storage";
import { assertOperatorTarget } from "../lib/operator-guard";
import {
  buildPersistedOutputEnvelope,
  PREVIEW_SIZE_CHARS,
} from "../lib/persisted-output-envelope";

/**
 * Fence the tool outputs that were written before there was a fence.
 *
 * The barrier is only ever about the future: `maybePersistLargeOutput` bounds
 * what a tool returns from now on, and `boundErrorStream` bounds the error
 * paths that used to slip past it. Neither rewrites a row that already exists
 * — and those rows are reloaded into a model's context every time their
 * conversation is reopened.
 *
 * Measured on production, 2026-09-18: of 4 299 `ai_messages`, 362 exceed
 * 200 KB and 26 exceed 800 KB, the largest at 33 110 519 bytes ≈ 8 M tokens.
 * Fourteen of those eighteen were written in September, against four in July.
 * They decompose as 6.4 MB `tool-python`, 1.5 MB `tool-bash`, 488 KB
 * `tool-manageWorkflow` — none microcompactable, because unlike a `read` their
 * results cannot be fetched again, so `microcompactMessages` leaves them
 * verbatim forever.
 *
 * **What it does to a row.** For each oversized tool part it uploads the full
 * output to the conversation's session storage at
 * `outputs/persisted/<toolCallId>.txt` and replaces the part's `output` with
 * the same `<persisted-output>` envelope the tools emit — the one the model
 * already knows how to reopen with `read()`. Nothing is lost: a sandbox
 * recreated for that conversation restores the file from S3.
 *
 * **Order matters.** The upload happens first and the row is only rewritten
 * when it succeeded. A row trimmed against a failed upload would be a
 * conversation pointing at a file that is not there.
 *
 * Run: `bun run repair:oversized-messages`. It loads the PACKAGE `.env`, like
 * `changelog:media` and for the same reason: `uploadSessionFile` reads the S3
 * configuration at module load, so even a dry run refuses to start without it
 * — and `bun --env-file=X` disables the `.env` of the working directory, so
 * the root file alone is not enough.
 * Add `--apply` to write; without it the script only reports. Add
 * `--threshold=<bytes>` to change what counts as oversized (default 200 000,
 * the size at which one message alone approaches half the context ceiling).
 */

/** Below this, a message is not worth rewriting. ~50 000 tokens. */
const DEFAULT_THRESHOLD_BYTES = 200_000;

/** A single part's output above this is what actually gets moved out. */
const PART_THRESHOLD_CHARS = 32_000;

const readThreshold = (argv: string[]): number => {
  const flag = argv.find((a) => a.startsWith("--threshold="));
  if (!flag) return DEFAULT_THRESHOLD_BYTES;
  const parsed = Number(flag.slice("--threshold=".length));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_THRESHOLD_BYTES;
};

/** `tool-<name>` parts holding a finished, oversized output. */
const oversizedToolParts = (
  parts: UIMessage["parts"],
): { index: number; toolCallId: string; serialized: string }[] => {
  const found: { index: number; toolCallId: string; serialized: string }[] = [];
  parts.forEach((part, index) => {
    if (!part.type.startsWith("tool-")) return;
    if (!("state" in part) || part.state !== "output-available") return;
    if (!("output" in part) || part.output === undefined) return;
    if (!("toolCallId" in part) || typeof part.toolCallId !== "string") return;
    const serialized =
      typeof part.output === "string"
        ? part.output
        : JSON.stringify(part.output, null, 2);
    if (serialized.length <= PART_THRESHOLD_CHARS) return;
    found.push({ index, toolCallId: part.toolCallId, serialized });
  });
  return found;
};

const run = async (): Promise<void> => {
  await assertOperatorTarget(Bun.argv);
  const apply = Bun.argv.includes("--apply");
  const threshold = readThreshold(Bun.argv);

  // Sized in the database rather than in this process: the whole point is that
  // these rows are too big to want in memory, and this answers the question
  // without shipping a single one over the wire.
  //
  // `octet_length(parts::text)` and NOT `pg_column_size(parts)`. The latter
  // reports what Postgres STORES — jsonb, TOASTed and compressed — and this
  // script is about what a model READS, which is the decompressed text. On
  // production, 2026-09-18, the two disagree by a factor of five: 362 rows
  // over 200 KB decompressed against 72 compressed, 26 over 800 KB against 1,
  // largest 33 110 519 bytes against 16 621 800. Filtering on the stored size
  // would have skipped 290 rows that each reload hundreds of KB into a context
  // window, which is the entire population this script exists for.
  const rows = await db
    .select({
      id: aiMessages.id,
      conversationId: aiMessages.conversationId,
      bytes: sql<number>`octet_length(${aiMessages.parts}::text)`,
    })
    .from(aiMessages)
    .where(sql`octet_length(${aiMessages.parts}::text) > ${threshold}`)
    .orderBy(sql`octet_length(${aiMessages.parts}::text) DESC`);

  console.log(
    `[repair-oversized] ${rows.length.toString()} message(s) over ${threshold.toLocaleString()} bytes`,
  );
  if (rows.length === 0) process.exit(0);

  let moved = 0;
  let rewritten = 0;
  for (const row of rows) {
    // oxlint-disable-next-line no-await-in-loop -- one row at a time on
    // purpose: each carries hundreds of KB and uploads to S3, and a burst of
    // those is how an operator script becomes the incident.
    const [full] = await db
      .select({ parts: aiMessages.parts })
      .from(aiMessages)
      .where(eq(aiMessages.id, row.id))
      .limit(1);
    if (!full) continue;

    const targets = oversizedToolParts(full.parts);
    console.log(
      `[repair-oversized]   ${row.id}  ${row.bytes.toLocaleString()} bytes  ${targets.length.toString()} oversized part(s)`,
    );
    if (targets.length === 0 || !apply) continue;

    const parts = [...full.parts];
    let changed = false;
    for (const target of targets) {
      const path = `outputs/persisted/${target.toolCallId.replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`;
      try {
        // oxlint-disable-next-line no-await-in-loop -- see above.
        await uploadSessionFile(
          row.conversationId,
          path,
          target.serialized,
          "text/plain",
        );
      } catch (err) {
        // The row keeps its payload. A message pointing at a file that was
        // never written is strictly worse than a message that is too big.
        console.warn(
          `[repair-oversized]     upload failed for ${target.toolCallId}, leaving the row alone:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      const part = parts[target.index];
      if (part === undefined) continue;
      // Re-narrowed here rather than trusted from the scan, the same way
      // `microcompact.ts` does the same swap: without re-checking, TypeScript
      // picks the wider branch of the part union where `output?: never` and
      // the envelope string is rejected. The runtime checks are guaranteed to
      // pass — `oversizedToolParts` already filtered on them — and they exist
      // for the narrowing alone.
      if (!("state" in part) || part.state !== "output-available") continue;
      parts[target.index] = {
        ...part,
        output: buildPersistedOutputEnvelope({
          path,
          sizeBytes: Buffer.byteLength(target.serialized, "utf8"),
          totalChars: target.serialized.length,
          preview: target.serialized.slice(0, PREVIEW_SIZE_CHARS),
        }),
      };
      changed = true;
      moved += 1;
    }

    if (!changed) continue;
    // oxlint-disable-next-line no-await-in-loop -- see above.
    await db.update(aiMessages).set({ parts }).where(eq(aiMessages.id, row.id));
    rewritten += 1;
  }

  if (!apply) {
    console.log("[repair-oversized] dry run — re-run with --apply");
    process.exit(0);
  }
  console.log(
    `[repair-oversized] done: ${moved.toString()} part(s) moved to session storage across ${rewritten.toString()} message(s)`,
  );
  process.exit(0);
};

void run();
