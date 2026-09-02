#!/usr/bin/env bun
/**
 * One-off data backfill: strip orphan `<think>` / `</think>` tokens from
 * already-persisted assistant message parts.
 *
 * Context: MiniMax M3 leaked a dangling `</think>` into the CONTENT channel
 * on continuation steps. The new `orphanTagMiddleware`
 * (`lib/model-registry/resolve.ts`) prevents this for NEW turns, but rows
 * written before its deploy still carry the stray tag as a `text` part —
 * which the frontend's `segmentParts` treats as a hard break, splitting one
 * tool run into many `ChatStepGroup` pills. This script cleans the history.
 *
 * Behaviour:
 *   - Scans `ai_messages` (role=assistant) whose parts JSON contains a
 *     `think>` token.
 *   - For each `text` part that contains a tag: removes the tag; DROPS the
 *     part entirely if nothing but whitespace remains (a lone `</think>`),
 *     otherwise keeps the cleaned text. Non-text parts are untouched.
 *   - Dry-run by default — prints what it WOULD change. Pass `--apply` to
 *     write.
 *
 * Usage:
 *   bun run scripts/backfill-orphan-think-tags.ts          # dry-run
 *   bun run scripts/backfill-orphan-think-tags.ts --apply  # write
 */
import db from "@fretik/shared/db";
import { aiMessages } from "@fretik/shared/db/schema";
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { and, eq, sql } from "drizzle-orm";

/**
 * Pure strip — mirrors `stripOrphanThinkTags` in
 * `lib/model-registry/resolve.ts`. Duplicated here so the one-off backfill
 * stays self-contained (no OpenRouter-client boot guard pulled in).
 */
const THINK_TAGS = ["<think>", "</think>"] as const;
const stripOrphanThinkTags = (text: string): string => {
  if (!text.includes("think")) return text;
  let out = text;
  for (const tag of THINK_TAGS) {
    out = out.split(`\n${tag}\n`).join("\n");
    out = out.split(tag).join("");
  }
  return out;
};

const apply = process.argv.includes("--apply");

await assertOperatorTarget(Bun.argv);

const rows = await db
  .select({ id: aiMessages.id, parts: aiMessages.parts })
  .from(aiMessages)
  .where(
    and(
      eq(aiMessages.role, "assistant"),
      sql`${aiMessages.parts}::text like '%think>%'`,
    ),
  );

console.log(
  `Scanning ${rows.length} assistant message(s) with a 'think>' token…`,
);

let messagesChanged = 0;
let partsCleaned = 0;
let partsDropped = 0;

for (const row of rows) {
  const parts = row.parts;
  if (!Array.isArray(parts)) continue;

  const next: typeof parts = [];
  let changed = false;

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      const cleaned = stripOrphanThinkTags(part.text);
      if (cleaned === part.text) {
        next.push(part);
        continue;
      }
      changed = true;
      if (cleaned.trim().length === 0) {
        partsDropped++;
        continue;
      }
      partsCleaned++;
      next.push({ ...part, text: cleaned });
      continue;
    }
    next.push(part);
  }

  if (!changed) continue;
  // Safety: never persist a message with zero parts.
  if (next.length === 0) {
    console.warn(`! skipping ${row.id} — cleaning would leave it empty`);
    continue;
  }

  messagesChanged++;
  if (apply) {
    await db
      .update(aiMessages)
      .set({ parts: next })
      .where(eq(aiMessages.id, row.id));
  }
}

console.log(
  `${apply ? "Applied" : "Dry-run"} — messages ${apply ? "updated" : "to update"}: ${messagesChanged}, text parts cleaned: ${partsCleaned}, parts dropped: ${partsDropped}`,
);
if (!apply && messagesChanged > 0) {
  console.log("Re-run with --apply to write these changes.");
}

process.exit(0);
