import db from "@fretik/shared/db";
import { aiChatFiles, aiMessages } from "@fretik/shared/db/schema";
import { getProvider } from "@fretik/shared/external-apps/registry";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { renderSnapshot } from "@fretik/shared/lib/chat-file-snapshot";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { signSandboxJwt } from "@fretik/shared/lib/external-apps/sandbox-jwt";
import { redis } from "@fretik/shared/lib/redis";
import { ANTI_BUFFERING_HEADERS } from "@fretik/shared/lib/sse-headers";
import {
  ChatStreamRequestSchema,
  UiMessageSchema,
} from "@fretik/shared/schemas/ai";
import {
  clearConversationActiveStream,
  getConversationActiveStream,
  setConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import { loadCatchUpContext } from "@fretik/shared/services/ai/catch-up";
import { getConversation } from "@fretik/shared/services/ai/get";
import { markConversationRead } from "@fretik/shared/services/ai/members/mark-read";
import { applyMentions } from "@fretik/shared/services/ai/members/mention";
import {
  loadConversationForAgent,
  saveMessage,
  saveMessages,
} from "@fretik/shared/services/ai/messages";
import { updateConversation } from "@fretik/shared/services/ai/update";
import { releaseSandbox } from "@fretik/shared/services/e2b/release-sandbox";
import { listConnections } from "@fretik/shared/services/external-apps/connections/list";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { listEnabledSkillsForTeam } from "@fretik/shared/services/skills/list-enabled-for-team";
import { MAX_FILES_PER_MESSAGE } from "@fretik/shared/utils/chatbot-limits";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  UI_MESSAGE_STREAM_HEADERS,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";
import { randomUUIDv7 } from "bun";
import { and, eq, inArray, sql } from "drizzle-orm";
import { buildSpeakerContext } from "../agents/chatbot/speaker-context";
import { summariseMissedMessages } from "../services/catch-up-summary";
import { notifyMentionedMembers } from "../services/chatbot-mention-email";
// Use node:stream/web's TransformStream rather than the DOM global:
// Bun implements both, but the DOM lib's TransformStream clashes with
// `AsyncIterableStream.pipeThrough` typings (DOM's ReadableStream has
// `[Symbol.asyncDispose]` on its iterator, web-streams doesn't — TS
// can't unify them). Using the node:stream/web types keeps the
// standard Bun runtime semantics (same native implementation, zero
// overhead) while matching the iterator shape the AI SDK expects.
import { TransformStream } from "node:stream/web";
import { z } from "zod";
import {
  chatbotAgentSet,
  getChatbotAgentSet,
  type ChatbotCallOptions,
} from "../agents/chatbot";
import type { ChatbotTools } from "../agents/chatbot/tools";
import type { AgentSet } from "../agents/shared/agent-builder";
import { writeSandboxAuthFile } from "../lib/conversation-storage";
import { flushLangfuse, langfuseEnabled } from "../lib/langfuse";
import { deleteScore, recordScore } from "../lib/langfuse-scores";
import {
  getProfileForRole,
  resolveChatModelForProfile,
} from "../lib/model-registry/resolve";
import type { ModelProfile } from "../lib/model-registry/types";
import { getResumableStreamContext } from "../lib/resumable-stream-context";
import { chatbotRateLimitMiddleware } from "../middlewares/chatbot-rate-limit";
import { internalMiddleware } from "../middlewares/internal";
import {
  buildActiveMemoryRecentTail,
  runActiveMemoryRecall,
} from "../services/active-memory/recall";
import { buildChatbotContextManifest } from "../services/chatbot-context/build-manifest";
import { sendChatbotFinishedEmailIfEnabled } from "../services/chatbot-finished-email";
import { compactConversation } from "../services/compaction/compact";
import { generateConversationTitle } from "../services/conversation-title/generate";
import type { HonoInternalAppType } from "../types/hono";

const InternalInvokeSchema = z.object({
  conversationId: z.uuid().optional(),
  messages: z.array(UiMessageSchema),
});

/**
 * Stream a chatbot turn with automatic primary → fallback model
 * failover. Both `agentSet.primary` and `.fallback` share every
 * other setting (tools, system prompt, prepareStep) — only the
 * underlying `LanguageModel` differs, so the retry is transparent
 * to the caller.
 *
 * Important nuance: `.stream()` resolves when the AI SDK has set up
 * the stream, NOT when the stream has finished. Errors that surface
 * AFTER the first chunk leave the fallback path unreachable — the
 * user sees a broken stream instead. This is the same behaviour as
 * the Phase 1-7d handler; see Phase E.4 in the correction plan for
 * the "true mid-stream fallback" follow-up.
 */
/**
 * Strip `file` UIMessage parts before `convertToModelMessages` hands
 * the history to the provider.
 *
 * Architecture boundary: UIMessage `file` parts exist for the
 * client's chat UI — inline attachment cards, history replay,
 * persistence in ai_messages.parts. They must NEVER reach the primary
 * chat model because Fretik deliberately decouples file handling
 * from the model:
 *
 *   - Model learns which files exist via the {{attachedFilesBlock}}
 *     system-prompt fragment (filename + mime + size + tool hint).
 *   - Model accesses content via `read()` (OCR sidecars), `vision`
 *     (Gemini sub-model, images + PDFs), and `python()`
 *     (pandas / pdfplumber / python-docx).
 *   - Primary model (MiniMax M2.7) is text-only — no vision, no
 *     native PDF, no XLSX parse. OpenRouter's auto-parse works for
 *     some PDFs but returns HTTP 400 "Failed to parse" on XLSX /
 *     PPTX / DOCX (reproducible on every run).
 *
 * Keeping file parts in `originalMessages` (→ toUIMessageStream) is
 * correct: the client re-renders the attachment card on message
 * replay, and `extractLastUserFileFilenames` above still reads them
 * to build the system-prompt block. Only the model's view is
 * scrubbed here.
 *
 * Claude Code reference pattern: files live on disk, Read tool
 * surfaces content to the model. The model never sees file bytes
 * or URLs in the conversation stream.
 */
const stripFilePartsForModel = (messages: UIMessage[]): UIMessage[] =>
  messages.map((m) => ({
    ...m,
    parts: m.parts.filter((p) => p.type !== "file"),
  }));

/**
 * Redis pub/sub channel used to carry explicit user-initiated
 * Stop signals from the POST `/chatbot/:id/stop` handler to the
 * in-flight `runChatbotTurn` that owns the corresponding streamId.
 *
 * We deliberately do NOT forward the HTTP request's AbortSignal
 * (`c.req.raw.signal`) to `streamText` — see the comment on
 * `streamChatbotWithFallback` — so tab close / network blips leave
 * the agent running. A true Stop requires a separate, explicit
 * client call that publishes to this channel; the subscriber set up
 * by `runChatbotTurn` then aborts the server-owned controller that
 * is passed to the LLM.
 */
const getAbortChannel = (streamId: string): string =>
  `fretik-chatbot-abort:${streamId}`;

/**
 * Note on abort signals (Phase 12 — resumable streams):
 * `streamChatbotWithFallback` accepts an OPTIONAL `abortSignal` that
 * is the caller's server-owned `AbortController.signal`. It is never
 * sourced from the HTTP request: when the HTTP connection drops (tab
 * closed, network blip, page refresh) we want the agent to finish so
 * `onFinish` can persist the assistant messages and the resumable
 * buffer stays consistent. The signal exists only to carry explicit
 * user Stops (POST `/:id/stop`) through a Redis pub/sub subscriber.
 * The Vercel AI SDK documents the same separation:
 * `docs/09-troubleshooting/15-abort-breaks-resumable-streams.mdx`.
 */
const streamChatbotWithFallback = async (params: {
  history: UIMessage[];
  callOptions: ChatbotCallOptions;
  agentSet: AgentSet<ChatbotCallOptions, ChatbotTools>;
  abortSignal?: AbortSignal;
}) => {
  const modelMessages = await convertToModelMessages(
    stripFilePartsForModel(params.history),
  );
  // Primary → fallback failover. Langfuse trace nesting + attribute
  // propagation are owned by the caller: `execute` (in `runChatbotTurn`)
  // wraps the whole turn in a single `chatbot-turn` active span, so every
  // `.stream()` here — and its nested tool / sub-agent spans — attaches
  // under that one trace. This function just runs the model.
  //
  // `servedBy` reports which agent actually answered: an eval run with a
  // candidate profile must know when a silent failover served the
  // FALLBACK model instead, or the candidate's scores are polluted.
  try {
    const result = await params.agentSet.primary.stream({
      messages: modelMessages,
      options: params.callOptions,
      abortSignal: params.abortSignal,
    });
    return { result, servedBy: "primary" as const };
  } catch (err) {
    // Sprint B §3.5: when the abort fired (user clicked Stop) the
    // primary call rejects with an AbortError — there is nothing to
    // fall back to. Re-raising lets the upstream handler treat the
    // turn as cleanly aborted instead of burning fallback tokens for
    // a generation the user already cancelled.
    if (params.abortSignal?.aborted) {
      throw err;
    }
    console.error("[chatbot] primary model failed, falling back:", err);
    const result = await params.agentSet.fallback.stream({
      messages: modelMessages,
      options: params.callOptions,
      abortSignal: params.abortSignal,
    });
    return { result, servedBy: "fallback" as const };
  }
};

/**
 * Persist every NEW assistant message produced by this turn. A
 * message is "new" iff its id is not already in the history we
 * loaded before the stream started. No-op when `conversationId`
 * is absent (stateless `/internal/invoke` callers are responsible
 * for their own persistence).
 *
 * The `memory` tool's audit attribution is anchored on
 * `AgentRuntimeContext.conversationId` (Option B from the memory
 * plan), so writes made during the stream are tagged with the
 * conversation directly — no need for a pre-stream message stub.
 */
/**
 * Narrow a UIMessage's `unknown` metadata to a plain object for
 * persistence — keeps whatever the `messageMetadata` stream callback
 * attached (`langfuseTraceId`, `usage`, `finishReason`). Per-turn
 * observability (tool calls, RAG hits, latency, cost) now lives in
 * Langfuse, not in the DB row.
 */
const narrowMetadata = (m: UIMessage): Record<string, unknown> | undefined =>
  m.metadata && typeof m.metadata === "object"
    ? (m.metadata as Record<string, unknown>)
    : undefined;

const persistAssistantMessages = async (
  conversationId: string | undefined,
  history: UIMessage[],
  finalMessages: UIMessage[],
): Promise<void> => {
  if (!conversationId) return;
  const known = new Set(history.map((m) => m.id));
  const assistantMessages = finalMessages.filter(
    (m) => !known.has(m.id) && m.role === "assistant",
  );
  if (assistantMessages.length === 0) return;
  await saveMessages(
    conversationId,
    assistantMessages.map((m) => ({
      role: "assistant" as const,
      parts: m.parts,
      metadata: narrowMetadata(m),
    })),
  );
};

/**
 * Conditionally start auto-title generation for a conversation's FIRST
 * turn. Returns a promise resolving to the generated title (or null), or
 * `null` when this turn must not be auto-titled.
 *
 * Big-actor behaviour (Claude / ChatGPT): the sidebar shows a placeholder
 * title, then swaps in a real one once the first turn lands. The title is
 * derived from the first user message only, so generation fires in
 * PARALLEL with the model answer (the message is already in `history`) and
 * adds ~0 latency — by the time the answer has streamed, the cheap-model
 * title is usually ready.
 *
 * Gated to the first turn of a real, owned conversation: `conversationId`
 * + `userId` present and no assistant message in the loaded history yet.
 * The membership-gated `updateConversation` write (finalizeAutoTitle) is
 * the authoritative guard against titling a conversation the caller can't
 * see — generation here is cheap and side-effect-free.
 */
const maybeStartAutoTitle = (
  params: RunChatbotTurnParams,
): Promise<string | null> | null => {
  if (
    params.conversationId === undefined ||
    params.callOptions.userId === undefined ||
    params.history.some((m) => m.role === "assistant")
  ) {
    return null;
  }
  const lastUser = [...params.history].reverse().find((m) => m.role === "user");
  const firstUserText = lastUser ? uiMessageText(lastUser) : "";
  if (firstUserText.length === 0) return null;
  return generateConversationTitle(firstUserText);
};

/**
 * Await the in-flight auto-title (if any), stream it to the client as a
 * transient `data-conversation-title` part (the @ai-sdk/vue `onData`
 * handler patches the sidebar + header cache live — never persisted into
 * `chat.messages`), and persist it on the conversation row.
 *
 * Kicked off (NOT awaited) right after `maybeStartAutoTitle` so the write
 * lands the MOMENT the cheap model returns — concurrent with the model
 * answer — instead of waiting for the (possibly long, tool-heavy) reply to
 * finish. The returned task is awaited once before `execute` returns so
 * the write is guaranteed inside the stream's lifetime. Soft-fails: a
 * title failure never breaks the turn (never rejects).
 */
const emitAutoTitle = async (args: {
  writer: UIMessageStreamWriter;
  params: RunChatbotTurnParams;
  titlePromise: Promise<string | null> | null;
}): Promise<void> => {
  const { writer, params, titlePromise } = args;
  if (!titlePromise) return;
  const { conversationId, callOptions } = params;
  if (conversationId === undefined || callOptions.userId === undefined) return;
  try {
    const title = await titlePromise;
    if (!title) return;
    writer.write({
      type: "data-conversation-title",
      transient: true,
      data: { conversationId, title },
    });
    await updateConversation({
      id: conversationId,
      teamId: callOptions.teamId,
      userId: callOptions.userId,
      updates: { title },
    });
  } catch (err) {
    console.warn(
      `${params.logPrefix} auto-title emit failed:`,
      err instanceof Error ? err.message : err,
    );
  }
};

/**
 * Tool names whose `input` is considered sensitive and must never
 * leave the backend verbatim on the streamed UI channel. The model
 * still sees the real input (it produced it and needs it to reason
 * on subsequent turns), and the DB-persisted assistant message keeps
 * the real input too — only the bytes sent to the browser are
 * scrubbed.
 *
 * The transform lives in front of `createUIMessageStreamResponse` so
 * onFinish / persistAssistantMessages receive the unmodified frame
 * set, which matters for model replay on the next turn.
 */
const SENSITIVE_TOOL_NAMES = new Set(["querySql"]);

/**
 * Keys stripped from a sensitive tool's `tool-input-available` chunk.
 * Keep the envelope (toolCallId, toolName, state) so the client still
 * renders the spinner and runs the tool lifecycle; just empty out the
 * payload fields that carry the secret.
 */
const SENSITIVE_INPUT_KEYS_TO_REDACT = new Set(["sql_query"]);

/**
 * Filter the outbound UI stream so sensitive tool inputs never reach
 * the client. Rewrites these chunk types:
 *
 *   - `tool-input-start` → pass through, but remember the toolCallId
 *     so we can scrub its downstream deltas/available events.
 *   - `tool-input-delta` → drop deltas for sensitive tools (they
 *     stream the raw JSON of the tool call args; replaying them
 *     client-side would defeat the scrub).
 *   - `tool-input-available` → keep the envelope, scrub the listed
 *     fields on its `input` object.
 *
 * Every other chunk type passes through untouched. Back-pressure is
 * preserved because we enqueue 0 or 1 chunks per incoming chunk.
 */
const buildSensitiveInputScrubber = () => {
  const sensitiveCallIds = new Set<string>();
  return new TransformStream({
    transform(chunk: UIMessageChunk, controller) {
      if (chunk.type === "tool-input-start") {
        if (SENSITIVE_TOOL_NAMES.has(chunk.toolName)) {
          sensitiveCallIds.add(chunk.toolCallId);
        }
        controller.enqueue(chunk);
        return;
      }
      if (
        chunk.type === "tool-input-delta" &&
        sensitiveCallIds.has(chunk.toolCallId)
      ) {
        // Swallow — the client will jump from input-streaming to
        // input-available without seeing any body fragment.
        return;
      }
      if (
        chunk.type === "tool-input-available" &&
        sensitiveCallIds.has(chunk.toolCallId)
      ) {
        const input = chunk.input;
        if (input && typeof input === "object") {
          const scrubbed: Record<string, unknown> = {};
          const inputRecord: Record<string, unknown> = { ...input };
          for (const key of Object.keys(inputRecord)) {
            scrubbed[key] = SENSITIVE_INPUT_KEYS_TO_REDACT.has(key)
              ? undefined
              : inputRecord[key];
          }
          controller.enqueue({ ...chunk, input: scrubbed });
        } else {
          controller.enqueue(chunk);
        }
        return;
      }
      controller.enqueue(chunk);
    },
  });
};

// ============================================================ //
// ATTACHED FILES                                                  //
// ============================================================ //

/**
 * Extract the filenames of every `file` part on the last user
 * message. The Nuxt app serialises uploaded attachments as AI SDK
 * `FileUIPart` objects with `{ type: 'file', filename, mediaType,
 * url }`; we key on `filename` to join with `ai_chat_files`.
 */
const extractLastUserFileFilenames = (history: UIMessage[]): string[] => {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  if (!lastUser) return [];
  const filenames: string[] = [];
  for (const part of lastUser.parts) {
    if (
      part.type === "file" &&
      "filename" in part &&
      typeof part.filename === "string" &&
      part.filename.length > 0
    ) {
      filenames.push(part.filename);
    }
  }
  return filenames;
};

/**
 * Concat all `text` parts of a `UIMessage` into a single string. Used
 * by the Active Memory recall path to build the judge prompt and the
 * recent conversation tail; tool / file parts are intentionally
 * dropped — the recall judge only needs visible text intent.
 */
const uiMessageText = (m: UIMessage): string => {
  const chunks: string[] = [];
  for (const part of m.parts) {
    if (part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
};

/**
 * Cheap MIME inference from filename extension. Sufficient for the
 * Active Memory recall judge (which uses `mimeType` as a coarse
 * routing hint, not a strict identifier) and avoids an extra DB
 * round-trip on `ai_chat_files`. Falls back to
 * `application/octet-stream` for unknown extensions — the judge
 * still sees the filename so it can pattern-match on the name alone.
 */
const inferMimeTypeFromFilename = (filename: string): string => {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "xml":
      return "application/xml";
    case "txt":
    case "md":
    case "log":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
};

/**
 * Build the input bundle for `runActiveMemoryRecall` from the
 * conversation history. Pure function — never throws, always
 * returns a usable shape (empty strings / arrays when there is
 * nothing to extract). The recall service applies its own skip
 * conditions (trivial messages, etc.) on top.
 */
const buildActiveMemoryInputs = (
  history: UIMessage[],
  filenames: string[],
): {
  userMessage: string;
  attachedFiles: { filename: string; mimeType: string }[];
  recentTail: string;
} => {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const userMessage = lastUser ? uiMessageText(lastUser) : "";
  const attachedFiles = filenames.map((filename) => ({
    filename,
    mimeType: inferMimeTypeFromFilename(filename),
  }));
  // Strip tool / file parts so the tail is judge-friendly. Excludes
  // the latest user message (already covered by `userMessage`).
  const trimmedHistory = history.slice(0, -1);
  const tailMessages = trimmedHistory
    .filter(
      (m): m is UIMessage & { role: "user" | "assistant" } =>
        m.role === "user" || m.role === "assistant",
    )
    .map((m) => ({ role: m.role, text: uiMessageText(m) }))
    .filter((m) => m.text.length > 0);
  const recentTail = buildActiveMemoryRecentTail(tailMessages);
  return { userMessage, attachedFiles, recentTail };
};

/**
 * Build the `{{attachedFilesBlock}}` fragment for the system prompt.
 * JOINs the filenames from the last user message's file parts
 * against `ai_chat_files` so every entry carries the authoritative
 * metadata (MIME type, size, sidecar availability). Returns an
 * empty string when nothing is attached — the prompt renderer
 * substitutes a fallback notice.
 */
const buildAttachedFilesBlock = async (
  conversationId: string | undefined,
  filenames: string[],
): Promise<string> => {
  if (!conversationId || filenames.length === 0) return "";

  const rows = await db
    .select({
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
      size: aiChatFiles.size,
      hasMarkdown: aiChatFiles.hasMarkdown,
      status: aiChatFiles.status,
      snapshot: aiChatFiles.snapshot,
    })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        inArray(aiChatFiles.filename, filenames),
      ),
    );

  if (rows.length === 0) return "";

  const byFilename = new Map(rows.map((r) => [r.filename, r]));
  const blocks: string[] = [];
  for (const filename of filenames) {
    const row = byFilename.get(filename);
    if (!row) continue;
    const sizeKb = (row.size / 1024).toFixed(1);
    // The filename is the on-disk basename (sanitized at upload
    // time — see services/chat-files/upload.ts). Every attachment
    // lives at `/workspace/attachments/{filename}` inside the
    // conversation sandbox. Emit a workspace-relative path the agent
    // can copy-paste verbatim into `read(...)` /
    // `pandas.read_excel('attachments/...')` without having to guess
    // where the sandbox is mounted.
    const relativePath = `attachments/${filename}`;

    // <attached_file> XML-style block per file. Pattern verbatim from
    // Claude.ai's `<notes_on_user_uploaded_files>` (model is trained
    // on this delimiter). Snapshot inside is a net-new affordance
    // sized to our tool surface — see `lib/chat-file-snapshot.ts`.
    const headerLine = `<attached_file path="${relativePath}" mime="${row.mimeType}" size_kb="${sizeKb}" status="${row.status}">`;
    const body: string[] = [headerLine];
    if (row.snapshot) {
      body.push(renderSnapshot(row.snapshot));
    }
    if (row.hasMarkdown) {
      body.push(
        `\`read({ file_path: '${relativePath}' })\` returns its text. For visual layout / signatures / diagrams use \`vision({ file_path: '${relativePath}', question: '...' })\`.`,
      );
    } else if (row.mimeType.startsWith("image/")) {
      body.push(
        `Call \`vision({ file_path: '${relativePath}', question: '...' })\` for visual questions (\`read\` has no text for this image).`,
      );
    } else if (
      row.mimeType.includes("spreadsheet") ||
      row.mimeType.includes("excel")
    ) {
      body.push(
        `Spreadsheet — open in \`python\` with \`pandas.read_excel('${relativePath}')\` / \`openpyxl\`.`,
      );
    } else {
      body.push(
        `\`read({ file_path: '${relativePath}' })\` for the full content.`,
      );
    }
    body.push(`</attached_file>`);
    blocks.push(body.join("\n"));
  }
  return blocks.join("\n\n");
};

/**
 * Bind every `ai_chat_files` row referenced by a freshly-persisted
 * user message to that message's id. Rows that were created during
 * the draft upload carry `messageId = NULL` — this is where the
 * orphan-reaper's "has the user actually sent this file?" check
 * flips to "yes".
 */
const linkChatFilesToMessage = async (
  conversationId: string,
  filenames: string[],
  messageId: string,
): Promise<void> => {
  if (filenames.length === 0) return;
  await db
    .update(aiChatFiles)
    .set({ messageId })
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        inArray(aiChatFiles.filename, filenames),
      ),
    );
};

/**
 * Per-turn input bag shared by `runChatbotTurn` and its setup helpers.
 */
interface RunChatbotTurnParams {
  conversationId: string | undefined;
  history: UIMessage[];
  callOptions: ChatbotCallOptions;
  /**
   * If present, this turn's SSE output is buffered under this id so
   * a GET /:conversationId/stream request can tee the same stream.
   * Populated only for the user-facing POST /stream (resumable).
   * Internal `/invoke` callers omit it — they drive their own stream
   * lifecycle.
   */
  resumableStreamId?: string;
  /**
   * Profile-keyed serving set + profile for this turn. Set by the
   * internal `/invoke` route when the caller sends
   * `X-Model-Profile-Key` (C3 eval gate); C8 will thread the
   * per-conversation pin through the same fields. Omitted → the
   * default `chat` role binding. Both fields travel together: the
   * profile drives the compaction threshold of the SAME model that
   * serves the turn.
   */
  agentSet?: AgentSet<ChatbotCallOptions, ChatbotTools>;
  modelProfile?: ModelProfile;
  /**
   * Scrub sensitive tool inputs (querySql.sql_query) from the outbound
   * SSE stream. Default true — the scrubber's threat model is the
   * end-user BROWSER. The internal `/invoke` route sets false: its
   * consumers are authenticated server-side callers (eval harness,
   * workers) that need the real arguments — the eval `tool-call-validity`
   * score is blind to any field scrubbed here.
   */
  scrubSensitiveInputs?: boolean;
  logPrefix: string;
}

/**
 * Bypass-resistant guard against a crafted request carrying more than
 * `MAX_FILES_PER_MESSAGE` file parts. Returns a 400 `Response` to
 * short-circuit the turn, or `null` to proceed. Clears the resumable
 * stream slot on rejection so a retry isn't blocked by the idempotence
 * guard.
 */
const rejectTooManyFiles = async (
  params: RunChatbotTurnParams,
  filenames: string[],
): Promise<Response | null> => {
  if (filenames.length <= MAX_FILES_PER_MESSAGE) {
    return null;
  }
  if (params.conversationId && params.resumableStreamId) {
    await clearConversationActiveStream(
      params.conversationId,
      params.resumableStreamId,
    );
  }
  return new Response(
    JSON.stringify({
      code: "TOO_MANY_FILES",
      message: `Maximum ${MAX_FILES_PER_MESSAGE.toString()} files per message.`,
    }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
};

/**
 * Per-turn external-app setup. Two things happen, both soft-failing so
 * a failure never blocks the turn:
 *
 *  (1) Load the active external-app connections (Outlook, …) the caller
 *      can see — surfaced to the agent via the `{{externalAppsBlock}}`
 *      prompt line and the runtime context.
 *  (2) Mint a fresh sandbox JWT (HS256, 1 h TTL) and write it to
 *      `/workspace/.fretik/auth.json` so `fretik_apps` calls
 *      authenticate this turn. The Python SDK re-reads the file every
 *      call, so the JWT rotates between turns without restarting the
 *      kernel. Skipped when `SANDBOX_JWT_SECRET` is unset.
 *
 * No-op (returns empty) for stateless `/invoke` callers without a
 * conversationId / userId.
 */
const loadExternalApps = async (
  params: RunChatbotTurnParams,
): Promise<{
  externalAppConnections: ChatbotCallOptions["externalAppConnections"];
  externalAppsBlock: string | undefined;
}> => {
  let externalAppConnections: ChatbotCallOptions["externalAppConnections"];
  let externalAppsBlock: string | undefined;
  if (
    params.conversationId !== undefined &&
    params.callOptions.userId !== undefined
  ) {
    try {
      const rows = await listConnections(
        params.callOptions.teamId,
        params.callOptions.userId,
      );
      const active = rows.filter((r) => r.status === "active");
      externalAppConnections = active.map((r) => {
        const provider = getProvider(r.providerKey);
        return {
          id: r.id,
          providerKey: r.providerKey,
          displayName: r.displayName,
          scope: r.userId === null ? ("team" as const) : ("user" as const),
          categories: provider?.manifest.categories ?? [],
          options: r.options,
        };
      });
      externalAppsBlock =
        externalAppConnections.length === 0
          ? undefined
          : externalAppConnections
              .map((c) => {
                // Surface only the options the provider opted to expose to
                // the agent (e.g. `persona` on communication providers).
                // Other options stay server-side.
                const provider = getProvider(c.providerKey);
                const formatOptionValue = (v: unknown): string | null => {
                  if (v === undefined || v === null) return null;
                  if (
                    typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean"
                  ) {
                    return String(v);
                  }
                  // Complex shapes (object / array) — drop from the system
                  // prompt rather than spilling JSON the agent doesn't need.
                  return null;
                };
                const exposed =
                  provider?.manifest.connectionOptions?.fields
                    .filter((f) => f.exposeToAgent)
                    .map((f) => {
                      const formatted = formatOptionValue(c.options?.[f.key]);
                      return formatted === null
                        ? null
                        : `${f.key}: ${formatted}`;
                    })
                    .filter((s): s is string => s !== null) ?? [];
                const parts = [
                  `display_name: "${c.displayName}"`,
                  `id: ${c.id}`,
                  `categories: [${c.categories.join(", ")}]`,
                  ...exposed,
                ];
                return `- ${c.providerKey} (${parts.join(", ")})`;
              })
              .join("\n");
    } catch (error) {
      console.warn(
        `${params.logPrefix} listConnections failed, proceeding without external apps:`,
        error instanceof Error ? error.message : error,
      );
    }

    const sandboxJwtSecret = Bun.env.SANDBOX_JWT_SECRET;
    const backendUrl = Bun.env.FRETIK_BACKEND_INTERNAL_URL;
    if (
      sandboxJwtSecret !== undefined &&
      sandboxJwtSecret !== "" &&
      backendUrl !== undefined &&
      backendUrl !== ""
    ) {
      try {
        const jwt = await signSandboxJwt({
          conversationId: params.conversationId,
          teamId: params.callOptions.teamId,
          userId: params.callOptions.userId,
          organizationId: params.callOptions.organizationId,
          turnId: params.callOptions.traceId ?? params.conversationId,
        });
        await writeSandboxAuthFile(params.conversationId, {
          jwt,
          backendUrl,
          turnId: params.callOptions.traceId ?? params.conversationId,
        });
      } catch (error) {
        console.warn(
          `${params.logPrefix} writeSandboxAuthFile failed — fretik_apps calls will fail until next turn:`,
          error instanceof Error ? error.message : error,
        );
      }
    } else if (externalAppConnections && externalAppConnections.length > 0) {
      console.warn(
        `${params.logPrefix} external-app connections exist but SANDBOX_JWT_SECRET/FRETIK_BACKEND_INTERNAL_URL is missing — fretik_apps calls will fail`,
      );
    }
  }
  return { externalAppConnections, externalAppsBlock };
};

/**
 * Build all per-turn system-prompt fragments in parallel (attached
 * files, persistent-context manifest, active-memory recall, dynamic
 * field catalogue, enabled-skills catalogue) and fold them — plus the
 * external-app connections — into the final `ChatbotCallOptions` passed
 * to the agent. Every fragment soft-fails to an empty value so a single
 * failing source never blocks the turn.
 */
const buildTurnCallOptions = async (
  params: RunChatbotTurnParams,
  filenames: string[],
  externalApps: {
    externalAppConnections: ChatbotCallOptions["externalAppConnections"];
    externalAppsBlock: string | undefined;
  },
): Promise<ChatbotCallOptions> => {
  // Captured in a const so the truthiness narrowing survives into the
  // `propagateAttributes` callback closure below (a const can't change, so
  // TS keeps the `string` narrowing; a property access would widen back).
  const activeMemoryUserId = params.callOptions.userId;
  const activeMemoryInputs = activeMemoryUserId
    ? buildActiveMemoryInputs(params.history, filenames)
    : null;
  const [
    attachedFilesBlock,
    chatbotContextManifest,
    activeMemoryRecall,
    teamFieldDefinitionsBlock,
    enabledSkillsBlock,
  ] = await Promise.all([
    buildAttachedFilesBlock(params.conversationId, filenames),
    buildChatbotContextManifest({
      userId: params.callOptions.userId,
      teamId: params.callOptions.teamId,
      organizationId: params.callOptions.organizationId,
    }).catch((error: unknown) => {
      // Never let a missing/corrupt manifest block a turn.
      console.warn(
        `${params.logPrefix} buildChatbotContextManifest failed, continuing without persistent context:`,
        error,
      );
      return {
        manifest: "",
        totalChars: 0,
        fileCount: 0,
        inlinedFileCount: 0,
      };
    }),
    activeMemoryInputs && activeMemoryUserId
      ? // Sibling trace linked to the conversation's session: the pre-turn
        // recall judge runs before `execute`, so it can't nest under
        // `chatbot-turn` — `propagateAttributes` keeps it navigable per
        // session instead of producing an orphan trace.
        propagateAttributes(
          {
            traceName: "active-memory-recall",
            ...(params.conversationId !== undefined
              ? { sessionId: params.conversationId }
              : {}),
            userId: activeMemoryUserId,
            tags: [`team:${params.callOptions.teamId}`],
          },
          () =>
            runActiveMemoryRecall({
              userMessage: activeMemoryInputs.userMessage,
              attachedFiles: activeMemoryInputs.attachedFiles,
              recentTail: activeMemoryInputs.recentTail,
              teamId: params.callOptions.teamId,
              organizationId: params.callOptions.organizationId,
              userId: activeMemoryUserId,
            }),
        )
      : Promise.resolve(null),
    // Compact `- key (type)` catalogue for the dynamic suffix.
    // Redis-cached (30 min TTL) so the per-turn cost is one HGET. A
    // failure must never block the turn — fall back to an empty block
    // and let the prompt render the "no dynamic fields" placeholder.
    getFieldDefinitionsForTeam({ teamId: params.callOptions.teamId })
      .then((defs) => defs.map((fd) => `- ${fd.key} (${fd.type})`).join("\n"))
      .catch((error: unknown) => {
        console.warn(
          `${params.logPrefix} getFieldDefinitionsForTeam failed, continuing without team fields:`,
          error instanceof Error ? error.message : error,
        );
        return "";
      }),
    // Team-filtered L1 skills listing. Always-on skills are always
    // present; team-configurable skills appear only when no override
    // exists or the team opted in. Disabled skills are absent entirely
    // — the agent has no path to invoke them. Failure falls back to an
    // empty block so the prompt renders the "no skills" placeholder
    // and the turn still ships.
    listEnabledSkillsForTeam(params.callOptions.teamId)
      .then((skills) =>
        skills
          .map((skill) => `- **${skill.name}** — ${skill.description}`)
          .join("\n"),
      )
      .catch((error: unknown) => {
        console.warn(
          `${params.logPrefix} listEnabledSkillsForTeam failed, continuing without skills catalogue:`,
          error instanceof Error ? error.message : error,
        );
        return "";
      }),
  ]);

  console.info(
    `${params.logPrefix} contextManifestChars=${chatbotContextManifest.totalChars.toString()} files=${chatbotContextManifest.fileCount.toString()} inlined=${chatbotContextManifest.inlinedFileCount.toString()} activeMemory=${activeMemoryRecall ? "hit" : "miss"} teamFieldsChars=${teamFieldDefinitionsBlock.length.toString()} enabledSkillsChars=${enabledSkillsBlock.length.toString()}`,
  );

  return {
    ...params.callOptions,
    attachedFilesBlock:
      attachedFilesBlock.length > 0 ? attachedFilesBlock : undefined,
    chatbotContextManifest:
      chatbotContextManifest.manifest.length > 0
        ? chatbotContextManifest.manifest
        : undefined,
    activeMemoryBlock: activeMemoryRecall?.block,
    teamFieldDefinitionsBlock:
      teamFieldDefinitionsBlock.length > 0
        ? teamFieldDefinitionsBlock
        : undefined,
    enabledSkillsBlock:
      enabledSkillsBlock.length > 0 ? enabledSkillsBlock : undefined,
    externalAppConnections: externalApps.externalAppConnections,
    externalAppsBlock: externalApps.externalAppsBlock,
  };
};

/**
 * Wire the user-initiated Stop plumbing for a resumable turn. Subscribe
 * to the Redis abort channel keyed by streamId so POST /:id/stop can
 * abort the controller mid-generation. The controller's signal is
 * server-owned, so HTTP client disconnects do NOT trigger it (tab close
 * still lets the turn finish and `onFinish` persist).
 *
 * Abort propagation chain (Sprint B §3.5): `abortController.abort()` →
 * AI SDK `streamText()` rejects → `@openrouter/ai-sdk-provider` forwards
 * `signal` to its `fetch()` → TCP close on the OpenRouter HTTPS socket.
 * Provider-level cancellation is provider-specific (Anthropic / OpenAI
 * honour it; MiniMax — TBC).
 *
 * Returns the controller + a `releaseAbortSubscriber` cleanup to call
 * from `onFinish`. No subscriber is created for non-resumable callers.
 */
const setupAbortChannel = async (
  params: RunChatbotTurnParams,
): Promise<{
  abortController: AbortController;
  releaseAbortSubscriber: () => Promise<void>;
}> => {
  const abortController = new AbortController();
  const abortSubscriber =
    params.resumableStreamId !== undefined ? redis.duplicate() : null;
  if (abortSubscriber && params.resumableStreamId !== undefined) {
    const channel = getAbortChannel(params.resumableStreamId);
    await abortSubscriber.subscribe(channel);
    abortSubscriber.on("message", (_ch, _msg) => {
      console.info(
        `${params.logPrefix} stop signal received streamId=${params.resumableStreamId ?? "?"}`,
      );
      abortController.abort();
    });
  }
  const releaseAbortSubscriber = async (): Promise<void> => {
    if (!abortSubscriber) return;
    try {
      await abortSubscriber.quit();
    } catch (err) {
      console.warn("[chatbot] abort subscriber cleanup failed", err);
    }
  };
  return { abortController, releaseAbortSubscriber };
};

/**
 * Shared tail of both routes: hydrate cache → stream with fallback
 * → return a UIMessage stream response whose `onFinish` persists
 * new assistant messages + fires the stale-output sweep.
 *
 * The outbound stream goes through a scrubber transform that strips
 * sensitive tool inputs (currently: `querySql.sql_query`). `onFinish`
 * runs on the PRE-scrub stream so persistence + future-turn replay
 * see the real values.
 *
 * Phase 12 (resumable streams): when a `conversationId` is provided
 * and a `streamId` was claimed by the caller, the outbound SSE stream
 * is simultaneously tee'd into a Redis-backed resumable buffer (via
 * the `resumable-stream` package). The `onFinish` callback clears the
 * `activeStreamId` column so the GET /:conversationId/stream
 * reconnection handler knows the turn is done. We intentionally do
 * NOT forward the request AbortSignal to the LLM — the turn must
 * finish regardless of whether the HTTP client is still connected so
 * `onFinish` can persist the assistant messages and keep the buffer
 * consistent.
 *
 * Intentionally NOT a middleware: the two routes have distinct
 * pre-work (Better Auth session vs X-Context headers, user-message
 * persistence only on /stream, …). Factoring the shared tail keeps
 * the two routes aligned without flattening their differences.
 */
const runChatbotTurn = async (
  params: RunChatbotTurnParams,
): Promise<Response> => {
  const filenames = extractLastUserFileFilenames(params.history);
  const tooManyFiles = await rejectTooManyFiles(params, filenames);
  if (tooManyFiles) {
    return tooManyFiles;
  }

  // Context files are NOT hydrated here. `read("context/...")` serves
  // them Bun-side (no sandbox), and the `python` / `bash` tools hydrate
  // them into `/workspace/context/...` on demand via
  // `prepareSandboxForCode` — so a turn that never runs code skips
  // sandbox acquisition entirely. Chat attachments + outputs come back
  // automatically when the storage façade restores from S3 on first
  // sandbox access.

  // External apps: active connections (surfaced to the agent) + a fresh
  // per-turn sandbox JWT for `fretik_apps`. See loadExternalApps.
  const externalApps = await loadExternalApps(params);

  // Assemble the per-turn system-prompt fragments + external apps into
  // the final call options handed to the agent. See buildTurnCallOptions.
  const callOptionsWithFiles = await buildTurnCallOptions(
    params,
    filenames,
    externalApps,
  );

  // User-initiated Stop plumbing (Phase 12). See setupAbortChannel.
  const { abortController, releaseAbortSubscriber } =
    await setupAbortChannel(params);

  // Serving set + profile for this turn (see RunChatbotTurnParams).
  // Resolved ONCE here so every consumer below — compaction threshold,
  // primary stream, zombie-recovery fallback — uses the same pair.
  const agentSet = params.agentSet ?? chatbotAgentSet;
  const modelProfile = params.modelProfile ?? getProfileForRole("chat");

  // Build the response stream via `createUIMessageStream({ execute })`.
  // The execute callback owns the full turn pipeline:
  //   1. Run `compactConversation` (CC-aligned, see
  //      services/compaction/compact.ts). Microcompact + threshold
  //      check, full summarisation when above threshold, with progress
  //      events surfaced to the client via `data-compaction` parts so
  //      the UI can show a "Compacting…" loader during the wait.
  //   2. Build the `streamText` result for the model turn.
  //   3. `writer.merge` the model UIMessage stream into the outer
  //      stream so its parts arrive AFTER the compaction status part.
  //
  // Soft-fail policy: any non-recoverable summariser failure (timeout,
  // PTL retries exhausted, malformed response) is logged inside
  // compactConversation and returns the (microcompacted) history
  // uncompacted. The provider will surface its own context-window
  // error mid-stream if even the microcompacted history is too large
  // — there is no longer a 422 hard-fail envelope.
  const COMPACTION_PART_ID = "compaction-status";
  const rawStream = createUIMessageStream<UIMessage>({
    originalMessages: params.history,
    // Sprint B §3.1 — observability for mid-stream errors. The
    // primary→fallback try/catch in `streamChatbotWithFallback` only
    // catches errors that surface BEFORE the stream is set up;
    // anything that errors after the first chunk reaches this
    // callback. We log it with full context and return a
    // user-friendly fragment so the client renders an actionable
    // message instead of an opaque truncated answer.
    onError: (err: unknown) => {
      if (abortController.signal.aborted) {
        console.info(`${params.logPrefix} stream ended after user abort`);
        return "Stopped.";
      }
      console.error(
        `${params.logPrefix} mid-stream error:`,
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
      return "The model lost the connection mid-answer. Please retry — your previous messages are preserved.";
    },
    onFinish: async ({ messages: finalMessages }) => {
      await persistAssistantMessages(
        params.conversationId,
        params.history,
        finalMessages,
      );
      // Per-turn observability (tool calls, RAG hits, latency, cost) is
      // captured by Langfuse via `experimental_telemetry` — see
      // `lib/langfuse.ts`. No custom DB telemetry blob or structured log
      // line here.
      // Email-on-finish notification. Reads `emailOnCompletion` off the
      // conversation row in DB itself — no need to plumb the toggle
      // through the request body. Fire-and-forget so a flaky SMTP path
      // never delays releasing the sandbox or the resumable stream
      // slot. The await on `persistAssistantMessages` above is
      // load-bearing: without it the user could click the link in the
      // email and land on a conversation whose latest turn isn't yet
      // visible.
      if (params.conversationId) {
        const conversationId = params.conversationId;
        void sendChatbotFinishedEmailIfEnabled({
          conversationId,
          finalMessages,
          logPrefix: params.logPrefix,
        }).catch((err: unknown) => {
          console.warn(
            `${params.logPrefix} email-on-finish failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      // Pause the conversation's E2B sandbox now that the turn is done
      // so we stop billing per-second between user messages. State
      // (filesystem + python kernel) is preserved across pause/resume.
      // Fire-and-forget — pause failures are logged but never block
      // returning the response. No-op when no sandbox was acquired.
      if (params.conversationId) {
        const conversationId = params.conversationId;
        void releaseSandbox(conversationId).catch((err: unknown) => {
          console.warn(
            `${params.logPrefix} sandbox pause failed:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      // Release the resumable-stream slot so the next turn can start
      // without tripping the 409 idempotence guard. Compare-and-swap
      // on the streamId keeps us safe from clearing a fresher turn.
      if (params.conversationId && params.resumableStreamId) {
        await clearConversationActiveStream(
          params.conversationId,
          params.resumableStreamId,
        );
      }
      await releaseAbortSubscriber();
      // Ship this turn's spans to Langfuse promptly (don't wait for the
      // batch interval). Soft-fails internally; never blocks the response.
      await flushLangfuse();
    },
    execute: async ({ writer }) => {
      // Trace I/O for the `chatbot-turn` parent span (set inside the
      // active-observation context below). Captured by `turnBody`.
      let visibleOutput = "";
      let traceFinishReason: string | undefined;

      // Auto-title the conversation from the first user message. The
      // generation + the emit/persist both run in PARALLEL with the model
      // answer: `emitAutoTitle` writes the `data-conversation-title` part
      // the moment the cheap model returns (typically mid-stream), so the
      // sidebar/header swap from the placeholder without waiting for the
      // reply. Awaited once before `execute` returns. No-op past the first
      // turn.
      const titlePromise = maybeStartAutoTitle(params);
      const titleTask = emitAutoTitle({ writer, params, titlePromise });

      // Full turn pipeline (compaction → model gen → zombie recovery) as a
      // thunk, so the Langfuse wrapper can run it inside one `chatbot-turn`
      // active span — every model + tool call then nests under ONE trace
      // per turn. Run directly when Langfuse is unconfigured.
      const turnBody = async (): Promise<void> => {
        const historyForModel = await compactConversation(params.history, {
          // Threshold follows the SERVING model's context window — the
          // profile resolved above (header override or `chat` binding).
          profile: modelProfile,
          onProgress: (event) => {
            // The shared `id` makes consecutive writes UPDATE the
            // single existing data part on the client (started → done
            // / failed) instead of stacking three separate cards.
            // The frontend renders this part as a UChatTool with a
            // loader while phase==='running' and transitions to a
            // success / failure state on the final write.
            if (event.phase === "started") {
              writer.write({
                type: "data-compaction",
                id: COMPACTION_PART_ID,
                data: { phase: "running", tokensBefore: event.tokensBefore },
              });
              return;
            }
            if (event.phase === "succeeded") {
              writer.write({
                type: "data-compaction",
                id: COMPACTION_PART_ID,
                data: {
                  phase: "done",
                  tokensBefore: event.tokensBefore,
                  tokensAfter: event.tokensAfter,
                  reductionPct: event.reductionPct,
                },
              });
              return;
            }
            // failed
            writer.write({
              type: "data-compaction",
              id: COMPACTION_PART_ID,
              data: { phase: "failed", tokensBefore: event.tokensBefore },
            });
          },
        });

        const { result, servedBy } = await streamChatbotWithFallback({
          history: historyForModel,
          callOptions: callOptionsWithFiles,
          agentSet,
          abortSignal: abortController.signal,
        });

        // Merge the model's UIMessage stream into the outer stream.
        // `originalMessages` / `onError` / `onFinish` were configured
        // on the outer createUIMessageStream above — passing them again
        // here would double-fire `onFinish` on persistence.
        //
        // `messageMetadata` is attached HERE (not on the outer
        // createUIMessageStream — `messageMetadata` is a `toUIMessageStream`
        // option, not a `createUIMessageStream` one). It is invoked on
        // the inner stream's `start` and `finish` events; we only emit
        // metadata on `finish` (start would overwrite a prior turn with
        // `undefined`). The returned blob lands in the assistant message's
        // `metadata`: `langfuseTraceId` (so the feedback control can score
        // the right Langfuse trace) plus `finishReason` / `usage` (read by
        // the eval harness over SSE). Full per-turn observability —
        // tool calls, RAG hits, latency, cost — lives in Langfuse.
        writer.merge(
          result.toUIMessageStream<UIMessage>({
            messageMetadata: ({ part }) => {
              if (part.type !== "finish") return undefined;
              const usage = part.totalUsage;
              // Trace id of this turn (active span context) — sent to the
              // client live AND folded into the persisted message metadata,
              // so the feedback control can score the right Langfuse trace.
              const traceId = getActiveTraceId();
              return {
                ...(traceId !== undefined ? { langfuseTraceId: traceId } : {}),
                telemetry: {
                  finishReason: part.finishReason,
                  rawFinishReason: part.rawFinishReason,
                  // Which agent answered + under which profile. The eval
                  // harness reads these over SSE: a candidate run where a
                  // silent failover served the fallback model must be
                  // flagged, not scored as the candidate.
                  servedBy,
                  modelProfileKey: modelProfile.key,
                  usage: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    totalTokens: usage.totalTokens,
                    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
                    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
                  },
                },
              };
            },
          }),
        );

        // Post-merge zombie recovery: when the primary finishes with
        // `finish=other|length` and no visible text, the SDK has already
        // streamed the (empty) primary output to the writer. We don't
        // bubble an error to the user — instead we chain into the
        // fallback model in the same writer. Mirrors the principle of
        // graceful degradation: the user gets a real answer instead of
        // a silent stop, at the cost of one extra model turn that only
        // fires on the rare zombie path.
        //
        // Note: this fires *regardless of whether tool calls happened*.
        // A turn that called `read` 5 times and then died without text
        // is still a zombie from the user's perspective — they see
        // collapsed tool-result UI cards and no answer.
        try {
          const [finishReason, finalText] = await Promise.all([
            result.finishReason,
            result.text,
          ]);
          // Trace output for `chatbot-turn`: the primary's visible answer
          // (overridden below if zombie-recovery's fallback produces text).
          visibleOutput = finalText ?? "";
          traceFinishReason = finishReason;
          const isBudgetExhausted =
            finishReason === "other" || finishReason === "length";
          const hasNoVisibleText = (finalText ?? "").trim().length === 0;
          const primaryZombied = isBudgetExhausted && hasNoVisibleText;
          if (primaryZombied && !abortController.signal.aborted) {
            console.error(
              `${params.logPrefix} primary zombied (finish=${finishReason}) — chaining to fallback model`,
            );
            // Inline UI notice so the user sees something happen during
            // the second model turn instead of staring at silence.
            const noticeId = randomUUIDv7();
            writer.write({ type: "text-start", id: noticeId });
            writer.write({
              type: "text-delta",
              id: `${noticeId}-d`,
              delta:
                "_Switching to the fallback model after the primary stopped without producing an answer…_\n\n",
            });
            writer.write({ type: "text-end", id: noticeId });

            const fallbackMessages = await convertToModelMessages(
              stripFilePartsForModel(historyForModel),
            );
            const fallbackResult = await agentSet.fallback.stream({
              messages: fallbackMessages,
              options: callOptionsWithFiles,
              abortSignal: abortController.signal,
            });
            writer.merge(
              fallbackResult.toUIMessageStream<UIMessage>({
                messageMetadata: ({ part }) => {
                  if (part.type !== "finish") return undefined;
                  const fbUsage = part.totalUsage;
                  const traceId = getActiveTraceId();
                  return {
                    ...(traceId !== undefined
                      ? { langfuseTraceId: traceId }
                      : {}),
                    telemetry: {
                      finishReason: part.finishReason,
                      rawFinishReason: part.rawFinishReason,
                      // Zombie recovery always serves the fallback agent.
                      servedBy: "fallback",
                      modelProfileKey: modelProfile.key,
                      usage: {
                        inputTokens: fbUsage.inputTokens,
                        outputTokens: fbUsage.outputTokens,
                        totalTokens: fbUsage.totalTokens,
                        reasoningTokens:
                          fbUsage.outputTokenDetails?.reasoningTokens,
                        cachedInputTokens:
                          fbUsage.inputTokenDetails?.cacheReadTokens,
                      },
                    },
                  };
                },
              }),
            );

            // If the fallback ALSO zombies, surface the actionable
            // remediation message — at this point we've burned both
            // models and the user deserves a clear next step.
            const [fbFinish, fbText] = await Promise.all([
              fallbackResult.finishReason,
              fallbackResult.text,
            ]);
            // The fallback produced the actually-visible answer — make it
            // the trace output instead of the primary's empty text.
            if ((fbText ?? "").trim().length > 0) {
              visibleOutput = fbText;
              traceFinishReason = fbFinish;
            }
            const fbZombie =
              (fbFinish === "other" || fbFinish === "length") &&
              (fbText ?? "").trim().length === 0;
            if (fbZombie) {
              console.error(
                `${params.logPrefix} fallback also zombied (finish=${fbFinish})`,
              );
              const finalId = randomUUIDv7();
              writer.write({ type: "text-start", id: finalId });
              writer.write({
                type: "text-delta",
                id: `${finalId}-d`,
                delta:
                  "Both models stopped without producing an answer. Please retry — for large attachments, try opening the file directly in `python` (e.g. `pdfplumber.open(...)`, `pd.read_csv(...)`).",
              });
              writer.write({ type: "text-end", id: finalId });
            }
          }
        } catch (err) {
          // Defensive — if `result.finishReason` / fallback chain fail
          // to resolve, we don't want to break the happy path. Log and
          // move on. The user has at least seen the primary's output
          // (even if empty).
          console.warn(
            `${params.logPrefix} zombie-fallback chain failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      };

      // No Langfuse → run the turn directly, no tracing overhead.
      if (!langfuseEnabled) {
        await turnBody();
        // Ensure the concurrent auto-title task settled before the stream
        // closes (it usually already wrote mid-stream).
        await titleTask;
        return;
      }

      // Single `chatbot-turn` parent observation per turn. `tags` /
      // `metadata` carry team + per-turn ids for filtering; `sessionId =
      // conversationId` groups the multi-turn thread in the Session view.
      // Order is load-bearing: `startActiveObservation` OUTER so
      // `chatbot-turn` is the active span when `propagateAttributes` runs —
      // the session / user / tags then land on the parent itself, not only
      // on its child spans. Every model + tool call inside `turnBody` nests
      // under this one observation.
      const o = params.callOptions;
      const tags = [`team:${o.teamId}`];
      if (o.traceId !== undefined) {
        tags.push(`turn:${o.traceId}`);
      }
      const metadata: Record<string, string> = {
        teamId: o.teamId,
        organizationId: o.organizationId,
      };
      if (o.conversationId !== undefined) {
        metadata.conversationId = o.conversationId;
      }
      if (o.traceId !== undefined) {
        metadata.traceId = o.traceId;
      }
      const lastUserMessage = [...params.history]
        .reverse()
        .find((m) => m.role === "user");
      const inputText = lastUserMessage ? uiMessageText(lastUserMessage) : "";

      await startActiveObservation(
        "chatbot-turn",
        async () => {
          await propagateAttributes(
            {
              traceName: "chatbot-turn",
              ...(o.conversationId !== undefined
                ? { sessionId: o.conversationId }
                : {}),
              ...(o.userId !== undefined ? { userId: o.userId } : {}),
              tags,
              metadata,
            },
            async () => {
              if (inputText.length > 0) {
                updateActiveObservation(
                  { input: inputText },
                  { asType: "agent" },
                );
              }
              await turnBody();
              updateActiveObservation(
                {
                  output: visibleOutput,
                  ...(traceFinishReason !== undefined
                    ? { metadata: { finishReason: traceFinishReason } }
                    : {}),
                },
                { asType: "agent" },
              );
            },
          );
        },
        { asType: "agent" },
      );

      // Ensure the concurrent auto-title task settled before the stream
      // closes (it usually already wrote mid-stream).
      await titleTask;
    },
  });

  const resumableStreamId = params.resumableStreamId;

  const baseResponse = createUIMessageStreamResponse({
    stream:
      params.scrubSensitiveInputs === false
        ? rawStream
        : rawStream.pipeThrough(buildSensitiveInputScrubber()),
    // When the caller wants resumability, tee the SSE-encoded stream
    // into a Redis-backed buffer so a subsequent GET can replay every
    // byte that was emitted — even if the original HTTP connection
    // drops. The AI SDK does the tee internally; this callback
    // receives a copy of the SSE text stream.
    ...(resumableStreamId !== undefined && {
      headers: ANTI_BUFFERING_HEADERS,
      consumeSseStream: async ({ stream }) => {
        try {
          const ctx = getResumableStreamContext();
          await ctx.createNewResumableStream(resumableStreamId, () => stream);
        } catch (err) {
          console.error("[chatbot] createNewResumableStream failed:", err);
        }
      },
    }),
  });

  // Wrap the SSE body with a heartbeat that emits a real UIMessage
  // `data-ping` frame at the byte level (not via the AI SDK's
  // `writer.write` — that path gets buffered by the internal
  // TransformStream and doesn't reach the client reliably during
  // long tool-call gaps). The ping is a proper v6 stream protocol
  // frame with `transient: true`: the @ai-sdk/vue `DefaultChatTransport`
  // parses it, sees it's transient, and drops it (never reaches
  // `chat.messages`, never triggers `onData`). Keeps the connection
  // alive through intermediate proxies and the browser's own idle
  // timer during the 10-20s "silent thinking" windows.
  return wrapResponseWithSseHeartbeat(baseResponse);
};

/**
 * Frequency of SSE keep-alive frames (10s — matches the shared
 * `streamStatusEvents` default and stays well under Bun's 30s
 * `idleTimeout`).
 */
const CHATBOT_HEARTBEAT_MS = 10_000;

/**
 * Build the raw SSE frame string for a heartbeat ping. Uses a real
 * v6 UIMessage `data-ping` part with `transient: true` so the client
 * parses it, forwards it to `onData` (which we never set), and never
 * persists it in `chat.messages`. Empty SSE comment frames
 * (`: keep-alive`) don't survive every proxy / Bun pipeline we've
 * tested — a real JSON frame with content does.
 */
const encodePingFrame = (): string => {
  const payload = JSON.stringify({
    type: "data-ping",
    data: { t: Date.now() },
    transient: true,
  });
  return `data: ${payload}\n\n`;
};

/**
 * TransformStream factory that forwards every incoming chunk unchanged
 * and, in parallel, enqueues a `data-ping` frame every `intervalMs`.
 * The interval is torn down in `flush()`, which the standard
 * guarantees runs exactly once when the input stream closes (clean
 * finish, LLM error, or client disconnect).
 *
 * Generic over the chunk shape so we can plug it on both the POST
 * `/stream` body (`Uint8Array` out of `createUIMessageStreamResponse`)
 * and the GET `/:id/stream` resume body (`string` out of
 * `resumable-stream`'s `resumeExistingStream`).
 */
const injectSseHeartbeat = <T extends Uint8Array | string>(
  intervalMs: number,
  encodePing: () => T,
): TransformStream<T, T> => {
  let interval: ReturnType<typeof setInterval> | null = null;
  return new TransformStream<T, T>({
    start(controller) {
      interval = setInterval(() => {
        try {
          controller.enqueue(encodePing());
        } catch {
          // Controller closed — flush() will clear the timer.
        }
      }, intervalMs);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
  });
};

const injectSseHeartbeatBytes = (intervalMs: number) => {
  const encoder = new TextEncoder();
  return injectSseHeartbeat<Uint8Array>(intervalMs, () =>
    encoder.encode(encodePingFrame()),
  );
};

const injectSseHeartbeatText = (intervalMs: number) =>
  injectSseHeartbeat<string>(intervalMs, encodePingFrame);

const wrapResponseWithSseHeartbeat = (response: Response): Response => {
  if (!response.body) return response;
  return new Response(
    response.body.pipeThrough(injectSseHeartbeatBytes(CHATBOT_HEARTBEAT_MS)),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  );
};

// ==================== //
// USER-FACING ROUTES   //
// ==================== //

const chatbotRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatbotRoutes.use("*", authMiddleware);
// Rate limit ONLY the user-facing /stream route, and only AFTER the
// auth middleware has populated `c.get("team")`. The limit is scoped
// per teamId — see middlewares/chatbot-rate-limit.ts for rationale.
chatbotRoutes.use("/stream", chatbotRateLimitMiddleware);

/**
 * POST /chatbot/stream — main entry from the Nuxt app.
 *
 * Flow:
 *  1. Validate body (conversationId + current messages array).
 *  2. Verify ownership of the conversation.
 *  3. Persist the incoming user message (last user message in the array).
 *  4. Load the tail of history from ai_messages for memory.
 *  5. Hydrate the S3-backed persisted-output hot cache.
 *  6. Stream a turn through `chatbotAgentSet.primary` with fallback.
 *  7. In `onFinish`, persist every assistant message produced this turn.
 *  8. Return the AI SDK's native UIMessage stream response.
 *
 * Per-request state (DynamicToolManager + TaskManager) is owned by
 * the agent's `prepareCall` hook — see `agents/shared/agent-builder.ts`.
 * No need to clear the `TaskManager` in `onFinish`: each request gets
 * its own instance inside `prepareCall`'s closure, and it's garbage-
 * collected when the stream ends. No cross-request leakage is
 * possible because nothing outside that closure holds a reference.
 */
chatbotRoutes.post("/stream", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const organization = c.get("organization");
  if (!team) return throwHttpError(403, teamRequired());

  const body: unknown = await c.req.json();
  const parsed = ChatStreamRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }

  const { conversationId, messages, mentionedUserIds, mentionsAssistant } =
    parsed.data;

  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  // Persist the new user message (last one in the incoming array),
  // attributed to its human author. This happens BEFORE the activation
  // gate so a human-to-human aside is still stored and seen by the others.
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser) {
    const savedUserMessage = await saveMessage({
      conversationId,
      role: "user",
      parts: lastUser.parts,
      metadata: lastUser.metadata,
      authorId: user.id,
    });
    // Bind every `ai_chat_files` row that was created in the draft
    // (messageId = NULL) to the message we just persisted. The orphan
    // reaper keys off `messageId IS NULL` to reap abandoned drafts —
    // flipping this field here removes those rows from its scan.
    if (savedUserMessage) {
      const attachedFilenames = extractLastUserFileFilenames([lastUser]);
      await linkChatFilesToMessage(
        conversationId,
        attachedFilenames,
        savedUserMessage.id,
      );
    }
  }

  // The sender has, by definition, just read the conversation — clear their
  // own unread / action-required state.
  await markConversationRead({ conversationId, userId: user.id });

  // Pull @mentioned teammates into the conversation and notify them.
  if (mentionedUserIds && mentionedUserIds.length > 0) {
    const mentioned = await applyMentions({
      conversationId,
      teamId: team.id,
      byUserId: user.id,
      mentionedUserIds,
    });
    void notifyMentionedMembers({
      mentioned,
      conversationId,
      conversationTitle: conversation.title,
      mentionedByName: user.name,
      logPrefix: "[chatbot]",
    });
  }

  // Activation gate. The agent answers by default, but stays silent when the
  // message @mentions humans only (a human-to-human aside). An explicit
  // @Assistant mention forces a reply.
  const hasHumanMention = (mentionedUserIds?.length ?? 0) > 0;
  const shouldAgentRespond = !(hasHumanMention && !mentionsAssistant);
  if (!shouldAgentRespond) {
    // Human-to-human aside: the message is stored and the mentioned
    // teammates are notified, but the agent doesn't reply. Return an empty
    // UI message stream (not JSON) so the AI SDK transport on the client
    // completes cleanly — the user's message stays, no assistant bubble.
    return createUIMessageStreamResponse({
      stream: createUIMessageStream<UIMessage>({ execute: () => undefined }),
    });
  }

  // Phase 12 resumable streams — idempotence guard. Claim the active
  // stream slot via a conditional UPDATE (only succeeds when
  // `activeStreamId IS NULL`). If another tab or a dup request already
  // kicked off a turn, we refuse with 409 so the client can switch to
  // the GET /:id/stream reconnection path instead of running two
  // turns in parallel.
  const streamId = randomUUIDv7();
  const claimed = await setConversationActiveStream(conversationId, streamId);
  if (!claimed) {
    return c.json(
      {
        code: "STREAM_IN_PROGRESS",
        message:
          "A chatbot turn is already streaming for this conversation. Reconnect via GET /chatbot/:id/stream instead.",
      },
      409,
    );
  }

  // Load last N messages from DB for the agent's memory window. 30 is
  // the Phase 8 default — compaction collapses the older portion when
  // the total exceeds 12K tokens.
  const history = await loadConversationForAgent(conversationId, 30);

  // Attribute speakers when the conversation is collaborative (≥2 members).
  // Solo conversations are left untouched — see buildSpeakerContext.
  const { history: speakerHistory, participantsBlock } = buildSpeakerContext({
    history,
    participants: conversation.members,
  });

  const callOptions: ChatbotCallOptions = {
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
    userName: user.name,
    conversationId,
    timeZone: c.req.header("X-Client-Timezone"),
    participantsBlock,
    // Reuse the resumable streamId as the per-turn trace id so step /
    // zombie / fallback log lines all share one identifier — one grep
    // recovers the full turn end-to-end. (Distinct from the Langfuse
    // trace id, which is the active OTel span context.)
    traceId: streamId,
  };

  return runChatbotTurn({
    conversationId,
    history: speakerHistory,
    callOptions,
    resumableStreamId: streamId,
    logPrefix: "[chatbot]",
  });
});

/**
 * GET /chatbot/:conversationId/stream — reconnection endpoint.
 *
 * Consumed by `@ai-sdk/vue`'s `DefaultChatTransport.resumeStream()`
 * (wired up in `useChatSession.ts`). Called on mount when the client
 * suspects a turn might still be streaming (e.g. the last message is
 * a pending user message, or we're coming back from a page refresh).
 *
 * Semantics:
 *   - 204 No Content  → no active stream, client falls back to the
 *                       history fetch + waits for the next POST.
 *   - 200 event-stream → an active stream exists; the body is the
 *                        tee'd SSE output from the current turn, and
 *                        `@ai-sdk/vue` merges it into `chat.messages`
 *                        exactly as it would a fresh POST.
 *   - 404 / 403        → classic auth failures.
 *
 * The Redis buffer lives 24h (default TTL in `resumable-stream`), but
 * practical recovery windows are short: `onFinish` normally clears
 * `activeStreamId` within seconds of the turn finishing.
 */
chatbotRoutes.get("/:conversationId/stream", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("conversationId");
  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  const activeStreamId = await getConversationActiveStream(conversationId);
  if (!activeStreamId) {
    return new Response(null, { status: 204 });
  }

  const ctx = getResumableStreamContext();
  const stream = await ctx.resumeExistingStream(activeStreamId);
  if (!stream) {
    // The sentinel has expired (24h TTL) or the publisher never got
    // to record it. Clear the column so we don't keep 204-missing and
    // hand back 204 to let the client fall back to the history.
    await clearConversationActiveStream(conversationId, activeStreamId);
    return new Response(null, { status: 204 });
  }

  return new Response(
    stream.pipeThrough(injectSseHeartbeatText(CHATBOT_HEARTBEAT_MS)),
    {
      status: 200,
      headers: {
        ...UI_MESSAGE_STREAM_HEADERS,
        ...ANTI_BUFFERING_HEADERS,
      },
    },
  );
});

/**
 * POST /chatbot/:conversationId/stop — explicit user Stop.
 *
 * Tab close, network blip and page refresh all leave the agent
 * running on purpose (see the "abort breaks resumable streams"
 * comment on `streamChatbotWithFallback`). Stop is the one path
 * that should actually kill the in-flight generation:
 *
 *   1. Publish on the per-stream Redis abort channel — the
 *      subscriber in `runChatbotTurn` flips the server-owned
 *      AbortController, which `streamText` respects and which
 *      triggers its `onFinish` with whatever partial messages
 *      have been produced so far.
 *   2. Clear `activeStreamId` unconditionally so the user can
 *      immediately POST a new prompt without hitting the 409
 *      idempotence guard.
 *
 * Idempotent: a second Stop on an already-cleared conversation
 * is a harmless no-op.
 */
chatbotRoutes.post("/:conversationId/stop", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("conversationId");
  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  const activeStreamId = await getConversationActiveStream(conversationId);
  if (!activeStreamId) {
    return c.json({ stopped: false, reason: "no-active-stream" }, 200);
  }

  await redis.publish(getAbortChannel(activeStreamId), "1");
  await clearConversationActiveStream(conversationId, activeStreamId);

  return c.json({ stopped: true }, 200);
});

/**
 * POST /chatbot/feedback — capture user quality signals as Langfuse scores.
 *
 * The client sends the `langfuseTraceId` it received in the assistant
 * message metadata (live via the stream, or persisted on reload). We verify
 * the caller owns the conversation, then write a source-named score on that
 * trace:
 *   - thumbs-up   → `user-feedback` = 1 (BOOLEAN)
 *   - thumbs-down → `user-feedback` = 0
 *   - retry       → `user-retry`    = 1 (implicit dissatisfaction signal)
 *   - clear       → DELETE the `user-feedback` score (thumb toggled off)
 *
 * Scores live in Langfuse only (Score Analytics, dataset curation, judge
 * calibration); a `metadata.userFeedback` UX flag on the message mirrors the
 * chosen thumb for reload — cleared alongside the score on `clear`.
 */
const ChatFeedbackSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  traceId: z.string().min(1).max(200),
  type: z.enum(["thumbs-up", "thumbs-down", "retry", "clear"]),
  comment: z.string().max(500).optional(),
});

chatbotRoutes.post("/feedback", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const body: unknown = await c.req.json();
  const parsed = ChatFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }
  const { conversationId, messageId, traceId, type, comment } = parsed.data;

  // Ownership check: only score traces from a conversation the caller owns.
  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  // Toggle off: delete the `user-feedback` score and drop the UX flag.
  if (type === "clear") {
    const recorded = await deleteScore(`${traceId}-user-feedback`);
    await db
      .update(aiMessages)
      .set({
        // jsonb `-` removes the key, preserving telemetry / langfuseTraceId.
        metadata: sql`coalesce(${aiMessages.metadata}, '{}'::jsonb) - 'userFeedback'`,
      })
      .where(
        and(
          eq(aiMessages.id, messageId),
          eq(aiMessages.conversationId, conversationId),
        ),
      );
    return c.json({ recorded }, 200);
  }

  const scoreName = type === "retry" ? "user-retry" : "user-feedback";
  const scoreValue = type === "thumbs-down" ? 0 : 1;
  const recorded = await recordScore({
    // Stable id per (trace, signal) → re-clicking a thumb upserts the one
    // score instead of stacking duplicates.
    id: `${traceId}-${scoreName}`,
    traceId,
    name: scoreName,
    value: scoreValue,
    dataType: "BOOLEAN",
    ...(comment !== undefined ? { comment } : {}),
  });

  // Persist the chosen thumb on the message itself — a UX flag, distinct
  // from the analytical Langfuse score — so it shows again on reload,
  // arriving for free with the message history (no extra read). Merge into
  // the existing metadata jsonb to preserve telemetry / langfuseTraceId.
  // The `WHERE conversationId` scopes the write to the owned conversation.
  // Retry is an implicit signal with no UI state to persist.
  if (type !== "retry") {
    const userFeedback = type === "thumbs-up" ? "up" : "down";
    await db
      .update(aiMessages)
      .set({
        metadata: sql`coalesce(${aiMessages.metadata}, '{}'::jsonb) || ${JSON.stringify({ userFeedback })}::jsonb`,
      })
      .where(
        and(
          eq(aiMessages.id, messageId),
          eq(aiMessages.conversationId, conversationId),
        ),
      );
  }

  return c.json({ recorded }, 200);
});

/**
 * POST /chatbot/:conversationId/summary — "summarise what I missed".
 *
 * Builds a short, speaker-aware catch-up of every message the caller hasn't
 * read yet (since their `lastReadAt` / `joinedAt`). Membership-gated. Does
 * NOT mark the conversation read — the client decides when to clear unread.
 */
chatbotRoutes.post("/:conversationId/summary", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("conversationId");

  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  // Optional `since` — the client's snapshot of its `lastReadAt` captured
  // before the conversation was marked read on open. Ignored if unparseable.
  const body = await c.req.json().catch(() => ({}));
  const rawSince = (body as { since?: unknown }).since;
  const since =
    typeof rawSince === "string" && !Number.isNaN(Date.parse(rawSince))
      ? new Date(rawSince)
      : undefined;

  const { priorContext, missed } = await loadCatchUpContext({
    conversationId,
    userId: user.id,
    ...(since ? { since } : {}),
  });
  const summary = await summariseMissedMessages({
    missed,
    priorContext,
    participants: conversation.members,
  });

  return c.json({ summary }, 200);
});

// ==================== //
// INTERNAL ROUTES      //
// ==================== //

const chatbotInternalRoutes = new OpenAPIHono<HonoInternalAppType>();
chatbotInternalRoutes.use("*", internalMiddleware);

/**
 * POST /internal/agents/chatbot/invoke
 *
 * Server-to-server entry for @fretik/api and @fretik/worker.
 * The caller must provide all agent context
 * via X-Context-* headers and a payload with either a conversationId
 * (to persist into ai_messages) or none (one-shot invocation with
 * inline messages, nothing persisted).
 */
chatbotInternalRoutes.post("/invoke", async (c) => {
  const context = c.get("context");

  const raw: unknown = await c.req.json();
  const parsed = InternalInvokeSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }
  const { conversationId, messages } = parsed.data;

  // C3 eval seam: an internal caller may pin this turn to an arbitrary
  // registry profile via `X-Model-Profile-Key`. Read HERE, not in
  // `middlewares/internal.ts` — the middleware is shared by every
  // internal route and the override must never leak into the
  // user-facing /stream path. Unknown keys 400 instead of silently
  // serving the default model: an eval run scored against the wrong
  // model is worse than a failed one.
  const profileKey = c.req.header("X-Model-Profile-Key");
  let agentSet: AgentSet<ChatbotCallOptions, ChatbotTools> | undefined;
  let modelProfile: ModelProfile | undefined;
  if (profileKey !== undefined) {
    try {
      agentSet = getChatbotAgentSet(profileKey);
      modelProfile = resolveChatModelForProfile(profileKey).profile;
    } catch {
      return c.json(
        {
          code: "UNKNOWN_MODEL_PROFILE",
          message: `Unknown model profile key: "${profileKey}"`,
        },
        400,
      );
    }
  }

  // D.3 warning: `messages` is silently ignored when `conversationId`
  // is set (the history is loaded from DB instead). Alert the caller
  // via log so this isn't a silent footgun. Not rejected to preserve
  // backward-compat with internal callers that might already send
  // both fields — if a future caller is updated to rely on either
  // mode explicitly, we can harden this into a 400 later.
  if (conversationId && messages.length > 0) {
    console.warn(
      "[chatbot.invoke] conversationId + messages both present — `messages` is IGNORED (history is loaded from DB). Send without conversationId for stateless invocation, or without messages for stateful resume.",
    );
  }

  const history: UIMessage[] = conversationId
    ? await loadConversationForAgent(conversationId, 30)
    : messages;

  const callOptions: ChatbotCallOptions = {
    organizationId: context.organizationId,
    teamId: context.teamId,
    userId: context.userId,
    userName: context.userName,
    conversationId,
    timeZone: context.timeZone,
    // Internal `/invoke` callers don't generate a resumable streamId,
    // so mint a fresh trace id here. Without it the agent-builder
    // prepareCall short-circuits the per-turn onStepFinish override
    // and step lines stay traceless — which is fine, just slightly
    // harder to correlate when debugging.
    traceId: randomUUIDv7(),
  };

  // Internal `/invoke` callers (e.g. workflow nodes) do NOT go through
  // the resumable-stream path — they keep the HTTP connection open for
  // the full turn and don't need tab-reopen reconnection. We still
  // avoid passing the request AbortSignal to the LLM to stay
  // consistent with the user-facing route; the caller should drive
  // its own lifecycle.
  return runChatbotTurn({
    conversationId,
    history,
    callOptions,
    agentSet,
    modelProfile,
    // Server-to-server channel: deliver real tool inputs (see
    // RunChatbotTurnParams.scrubSensitiveInputs).
    scrubSensitiveInputs: false,
    logPrefix: "[chatbot.invoke]",
  });
});

export { chatbotInternalRoutes, chatbotRoutes };
