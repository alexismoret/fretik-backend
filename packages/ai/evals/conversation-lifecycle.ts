/**
 * Ephemeral conversation plumbing for the eval harness.
 *
 * Most sandbox-backed tools (bash, python, read, …) need
 * an active `conversationId` in their runtime context — without one
 * they short-circuit to a `NO_CONVERSATION` error. Running evals
 * statelessly therefore turns every sandbox call into a harmless
 * no-op and forces the agent to loop on failed retries, distorting
 * both the tool-routing signal and the latency numbers.
 *
 * To mirror production, every eval case now runs against a fresh
 * `ai_conversations` row. We create it here (bypassing the HTTP layer
 * via the shared DB connection), pass the id through to the chatbot
 * `/internal/invoke` endpoint, and cascade-delete it on cleanup. The
 * orchestrator's session for the same id is destroyed at the same
 * time so the pool recovers its capacity.
 *
 * Cases that declare a `fixtures: [...]` array have those files pushed
 * into the conversation sandbox at `/workspace/attachments/{filename}`
 * via the storage façade (with an S3 mirror so a sandbox recreated
 * after expiry sees them again), registered in `ai_chat_files`, and
 * appended as `file` parts on the seeded user message — mirroring
 * exactly what the production `/chatbot/stream` upload path produces.
 *
 * NO impact on production paths — this module is only imported by
 * `evals/run.ts`.
 */

import db from "@fretik/shared/db";
import {
  aiChatFiles,
  aiConversations,
  aiMessages,
  fileExtractions,
} from "@fretik/shared/db/schema";
import { writeExtractionSidecar } from "@fretik/shared/services/file-extraction/storage";
import {
  detectMimeFromBytes,
  isImageMime,
} from "@fretik/shared/utils/mimeTypes";
import { SHA256 } from "bun";
import { eq } from "drizzle-orm";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  attachUserFile,
  WORKSPACE_DIRS,
  WORKSPACE_ROOT,
} from "../src/lib/conversation-storage";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(MODULE_DIR, "fixtures");

interface SeededChatFile {
  filename: string;
  mimeType: string;
  size: number;
  hasMarkdown: boolean;
  fileHash: string;
}

/**
 * Pre-populate the shared content-addressed extraction cache from a
 * fixture's `{stem}.md` ground-truth OCR (or seed an `image-skip` row
 * for text-less images). This makes the production `read` path get a
 * deterministic cache HIT instead of calling live Mistral OCR, while
 * exercising the real lazy-extraction code path (and dedup —
 * `onConflictDoNothing` lets two cases share one fixture). `null`
 * markdown = no sidecar (image-skip → `read` points at `vision`).
 */
const seedExtractionCache = async (
  organizationId: string,
  fileHash: string,
  mimeType: string,
  markdown: string | null,
  route: "mistral-ocr" | "image-skip",
): Promise<void> => {
  const sidecarS3Key =
    markdown !== null
      ? await writeExtractionSidecar(organizationId, fileHash, markdown)
      : null;
  await db
    .insert(fileExtractions)
    .values({
      organizationId,
      fileHash,
      mimeType,
      route,
      sidecarS3Key,
      charCount: markdown?.length ?? null,
      status: "ready",
    })
    .onConflictDoNothing({
      target: [fileExtractions.organizationId, fileExtractions.fileHash],
    });
};

/**
 * Lightweight MIME guess — keeps us free from node:mime dependencies.
 * Defaults to `application/octet-stream` so unknown formats still get
 * seeded; the agent receives the literal extension in the filename
 * and can route correctly.
 */
const guessMime = (filename: string): string => {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".xml":
      return "application/xml";
    case ".html":
    case ".htm":
      return "text/html";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "application/octet-stream";
  }
};

/**
 * Push a fixture's ORIGINAL binary into the conversation sandbox at
 * `/workspace/attachments/{filename}` (for `python` / `bash`), and
 * pre-seed the content-addressed extraction cache from its `{stem}.md`
 * ground-truth so `read` resolves deterministically. Returns the
 * metadata the caller needs to register the file in `ai_chat_files`.
 *
 * Missing fixtures emit a warning and resolve to `null` — the case
 * then runs with an empty workspace, which is how the suite used to
 * behave before fixtures existed. This keeps the harness usable on
 * fresh checkouts where the operator hasn't yet provisioned the
 * binary files.
 */
const pushFixtureIntoSandbox = async (
  conversationId: string,
  organizationId: string,
  filename: string,
): Promise<SeededChatFile | null> => {
  const src = resolve(FIXTURES_DIR, filename);
  const srcFile = Bun.file(src);
  if (!(await srcFile.exists())) {
    console.warn(
      `[evals] fixture "${filename}" not found at ${src} — case will run without it. See evals/fixtures/README.md.`,
    );
    return null;
  }

  // Push the ORIGINAL binary into the sandbox (+ S3 backup) — `python` /
  // `bash` operate on it. NO markdown sidecar lands in the sandbox; the
  // new `read` path reads extraction from the content-addressed cache.
  const bytes = new Uint8Array(await srcFile.arrayBuffer());
  await attachUserFile(conversationId, filename, bytes);

  const mimeType = await detectMimeFromBytes(bytes, guessMime(filename));
  const fileHash = SHA256.hash(bytes, "hex");

  // Pre-seed the extraction cache from the operator's `{stem}.md`
  // ground-truth OCR so `read` resolves deterministically without a live
  // Mistral call. Text-less images get an `image-skip` row so `read`
  // points at `vision` instead.
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  const sidecarFile = Bun.file(resolve(FIXTURES_DIR, `${stem}.md`));
  let hasMarkdown = false;
  if (await sidecarFile.exists()) {
    const markdown = await sidecarFile.text();
    await seedExtractionCache(
      organizationId,
      fileHash,
      mimeType,
      markdown,
      "mistral-ocr",
    );
    hasMarkdown = true;
  } else if (isImageMime(mimeType)) {
    await seedExtractionCache(
      organizationId,
      fileHash,
      mimeType,
      null,
      "image-skip",
    );
  }

  return {
    filename,
    mimeType,
    size: bytes.byteLength,
    hasMarkdown,
    fileHash,
  };
};

/**
 * Insert a fresh conversation row scoped to the eval team and persist
 * the user message into `ai_messages` as the first turn's history.
 *
 * The `/internal/invoke` handler IGNORES the `messages` field in its
 * request body whenever a `conversationId` is provided — it loads
 * history straight from `ai_messages` via `loadConversationForAgent`.
 * So our eval harness must seed the conversation with the prompt
 * before invoking, otherwise the model sees an empty history and
 * emits nothing.
 *
 * When `fixtures` is provided, the matching files are pushed into the
 * conversation sandbox at `/workspace/attachments/...` via the
 * storage façade, registered in `ai_chat_files`, and appended as
 * `file` parts on the seeded user message so
 * `buildAttachedFilesBlock` picks them up into the system prompt's
 * `<file_attachments>` section.
 *
 * The title is prefixed with `[eval]` so any orphaned rows are easy
 * to spot in the dashboard. Cascade-delete via the FK on cleanup.
 */
export const createEphemeralConversation = async (args: {
  teamId: string;
  organizationId: string;
  userId?: string;
  label: string;
  prompt: string;
  fixtures?: string[];
}): Promise<string> => {
  const [convRow] = await db
    .insert(aiConversations)
    .values({
      organizationId: args.organizationId,
      teamId: args.teamId,
      userId: args.userId ?? null,
      agentType: "chatbot",
      title: `[eval] ${args.label}`.slice(0, 200),
    })
    .returning({ id: aiConversations.id });
  if (!convRow) {
    throw new Error("Failed to create ephemeral conversation");
  }
  const conversationId = convRow.id;

  // Seed fixtures first so we know which files actually landed before
  // shaping the user message's `parts`. A missing fixture is non-fatal.
  const seeded: SeededChatFile[] = [];
  for (const filename of args.fixtures ?? []) {
    // eslint-disable-next-line no-await-in-loop -- serial by design:
    // each push hits the sandbox + S3 backup queue, and keeping the
    // calls sequential simplifies error handling with minimal latency
    // cost (typical fixture set is < 10 files).
    const meta = await pushFixtureIntoSandbox(
      conversationId,
      args.organizationId,
      filename,
    );
    if (meta) seeded.push(meta);
  }

  // Build user-message parts: one text part + one `file` part per
  // successfully seeded fixture. Shape mirrors what `@ai-sdk/vue`
  // produces on the frontend for drag-and-dropped attachments:
  // `{ type: 'file', mediaType, filename, url }`. The chatbot handler
  // reads `filename` via `extractLastUserFileFilenames`.
  //
  // The AI SDK's `UIMessage['parts']` type is a strict discriminated
  // union we don't need to conform to here — Drizzle persists the
  // array as JSONB verbatim and the handler reads back via
  // `isFileUIPart` / `part.type === 'file'` duck-typing. We cast
  // through `never` to bypass the compile-time narrowing.
  const messageParts: Array<Record<string, unknown>> = [
    { type: "text", text: args.prompt },
  ];
  for (const f of seeded) {
    messageParts.push({
      type: "file",
      mediaType: f.mimeType,
      filename: f.filename,
      // Production uses an S3 presigned URL. The /invoke path never
      // re-downloads the file (it relies on the sandbox), so a stub
      // URL here is harmless.
      url: `${WORKSPACE_ROOT}/${WORKSPACE_DIRS.attachments}/${f.filename}`,
    });
  }

  const [userMessageRow] = await db
    .insert(aiMessages)
    .values({
      conversationId,
      role: "user",
      parts: messageParts as unknown as never,
      metadata: null,
    })
    .returning({ id: aiMessages.id });
  if (!userMessageRow) {
    throw new Error("Failed to persist seeded user message");
  }

  // Register the seeded fixtures in `ai_chat_files` so
  // `buildAttachedFilesBlock` can resolve them and emit the rich
  // `<file_attachments>` system-prompt section. `status='ready'` +
  // `fileHash` set — `read` resolves the extraction from the
  // content-addressed cache pre-seeded above (no live OCR).
  if (seeded.length > 0) {
    await db.insert(aiChatFiles).values(
      seeded.map((f) => ({
        conversationId,
        messageId: userMessageRow.id,
        filename: f.filename,
        mimeType: f.mimeType,
        size: f.size,
        fileHash: f.fileHash,
        hasMarkdown: f.hasMarkdown,
        status: "ready" as const,
      })),
    );
  }

  return conversationId;
};

/**
 * Destroy the ephemeral conversation + its sandbox session. Cascade
 * deletes all `ai_messages` + `ai_chat_files` rows via the FK. The
 * conversation's E2B sandbox is left to expire under E2B's TTL — its
 * S3 mirror under `chatbot-sessions/{convId}/` is governed by S3
 * lifecycle policies. Errors are swallowed (and logged) so a bad
 * cleanup can't abort a whole eval run.
 */
export const destroyEphemeralConversation = async (
  conversationId: string,
): Promise<void> => {
  // 1. Tear down the orchestrator session, if any. Best-effort —
  //    orchestrator being unreachable is not a fatal condition here.
  const orchestratorUrl = process.env.ORCHESTRATOR_URL;
  const internalKey = process.env.INTERNAL_KEY;
  if (orchestratorUrl && internalKey) {
    try {
      await fetch(
        `${orchestratorUrl.replace(/\/+$/, "")}/api/v1/sessions/${encodeURIComponent(conversationId)}`,
        {
          method: "DELETE",
          headers: { "X-Internal-Key": internalKey },
        },
      );
    } catch (err) {
      console.warn(
        `[evals] orchestrator session teardown failed for ${conversationId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Delete the conversation row. FK cascade cleans up ai_messages
  //    AND ai_chat_files via their FK constraints.
  try {
    await db
      .delete(aiConversations)
      .where(eq(aiConversations.id, conversationId));
  } catch (err) {
    console.warn(
      `[evals] conversation row teardown failed for ${conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
