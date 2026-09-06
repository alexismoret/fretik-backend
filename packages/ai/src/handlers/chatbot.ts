import db, { type Transaction } from "@fretik/shared/db";
import { aiChatFiles, aiMessages } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  getSessionFilePresignedUrl,
  readSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import { publishConversationTaskResume } from "@fretik/shared/lib/conversation-task-resume";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
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
import {
  publishConversationEvent,
  subscribeConversationEvents,
} from "@fretik/shared/services/ai/conversation-events";
import { getConversation } from "@fretik/shared/services/ai/get";
import { markConversationRead } from "@fretik/shared/services/ai/members/mark-read";
import { applyMentions } from "@fretik/shared/services/ai/members/mention";
import {
  deleteStalePartialMessages,
  loadConversationForAgent,
  saveMessage,
  saveMessages,
} from "@fretik/shared/services/ai/messages";
import {
  listViewers,
  markPresent,
  publishTyping,
  removePresent,
} from "@fretik/shared/services/ai/presence";
import { drainTurnLogToHistory } from "@fretik/shared/services/ai/turn-drain";
import {
  getTurnLogStatus,
  isTurnLogOrphan,
  openTurnLog,
  pumpChunksToTurnLog,
  readTurnLogAsSse,
} from "@fretik/shared/services/ai/turn-log";
import { recordTurnIncrementally } from "@fretik/shared/services/ai/turn-recorder";
import { updateConversation } from "@fretik/shared/services/ai/update";
import { hasResumableConversationTasks } from "@fretik/shared/services/conversation-tasks/list";
import { emitDomainEvent } from "@fretik/shared/services/domain-events/emit";
import { releaseSandbox } from "@fretik/shared/services/e2b/release-sandbox";
import { getTeamToolPolicies } from "@fretik/shared/services/tool-policies/get-for-team";
import { MAX_FILES_PER_MESSAGE } from "@fretik/shared/utils/chatbot-limits";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  getActiveTraceId,
  propagateAttributes,
  startActiveObservation,
  startObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import type { SpanContext } from "@opentelemetry/api";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  toUIMessageStream,
  UI_MESSAGE_STREAM_HEADERS,
  type GenerateTextOnStepEndCallback,
  type ModelMessage,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { randomUUIDv7 } from "bun";
import { and, eq, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { buildSpeakerContext } from "../agents/chatbot/speaker-context";
import { summariseMissedMessages } from "../services/catch-up-summary";
import { notifyMentionedMembers } from "../services/chatbot-mention-email";
import { isAnnouncedActionStop } from "../services/turn-continuation/judge";
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
  defaultChatbotAgentSet,
  getChatbotAgentSet,
  type ChatbotCallOptions,
} from "../agents/chatbot";
import type { ChatbotTools } from "../agents/chatbot/tools";
import type { AgentSet } from "../agents/shared/agent-builder";
import {
  assembleContextFragments,
  ATTACHED_FILES_UNAVAILABLE,
  buildConversationAttachedFilesBlock,
  loadExternalApps,
} from "../agents/shared/fragments";
import { subscribeAbort } from "../lib/abort-subscriber";
import { flushLangfuse, langfuseEnabled } from "../lib/langfuse";
import { deleteScore, recordScore } from "../lib/langfuse-scores";
import {
  effectiveReasoningLevel,
  ensureModelRegistryWarm,
  getProfileForRole,
  reasoningParamForProfile,
  resolveChatModelForProfile,
} from "../lib/model-registry/resolve";
import { resolveTeamFlagship } from "../lib/model-registry/team-model";
import type { ModelProfile, ReasoningLevel } from "../lib/model-registry/types";
import { buildSensitiveInputScrubber } from "../lib/scrub-stream";
import { createSseEventQueue } from "../lib/sse-event-queue";
import { withHeartbeat } from "../lib/sse-heartbeat";
import {
  classifyStreamError,
  describeStreamError,
  FAILOVER_SENTINEL,
  isRecoverableToolCallError,
  isTransparentlyRecoverable,
  streamWithRetryThenFallback,
  toStructuredError,
  withSoftTimeout,
} from "../lib/stream-errors";
import { withNamedTrace } from "../lib/trace-tool";
import { forgetTurnUsage, readTurnUsage } from "../lib/turn-usage";
import { uuidv7TimestampMs } from "../lib/uuidv7-time";
import { chatbotRateLimitMiddleware } from "../middlewares/chatbot-rate-limit";
import { internalMiddleware } from "../middlewares/internal";
import { sendChatbotFinishedEmailIfEnabled } from "../services/chatbot-finished-email";
import { compactConversation } from "../services/compaction/compact";
import { generateConversationTitle } from "../services/conversation-title/generate";
import {
  hasNativeFileParts,
  NATIVE_FILE_PARSER_PLUGINS,
  planNativeIngestion,
  prepareModelMessages,
  type PrepareModelMessagesDeps,
} from "../services/native-input";
import {
  buildRecallRecentTail,
  runUnifiedRecall,
} from "../services/recall/recall";
import type { HonoInternalAppType } from "../types/hono";
import {
  buildTurnMessageMetadata,
  filterNewAssistantMessages,
  narrowMessageMetadata,
} from "./turn-helpers";

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
 * Attachments reach the model through `prepareModelMessages`
 * (`services/native-input`) before `convertToModelMessages`. For
 * non-multimodal / inert profiles it is byte-identical to the historical
 * `stripFilePartsForModel` (which now lives there): file parts are
 * scrubbed and the model reaches content via `read`/`vision`/`python`.
 * Multimodal profiles (C5) receive image/video parts native instead —
 * see that module. File parts always survive in `originalMessages`
 * (history replay, persistence, the {{attachedFilesBlock}} fragment).
 *
 * The two I/O helpers below mirror the chatbot-session-storage
 * signatures so they drop straight into the deps.
 */
const buildNativeInputDeps = (
  conversationId: string | undefined,
): PrepareModelMessagesDeps => ({
  conversationId,
  readSessionFile,
  presignSessionFile: getSessionFilePresignedUrl,
});

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
 * Provider-agnostic Stop backstop. Once the turn's abort signal fires,
 * stop forwarding model chunks downstream so a provider that ignores
 * fetch-abort can't keep painting text into the response — and thus into
 * the resumable buffer that reconnecting / collaborative viewers read.
 * The model stream is also abort-signalled upstream; this guarantees the
 * visible output truncates at the Stop regardless of provider behaviour
 * (the "break the consumption loop" pattern, expressed as a transform).
 */
const dropChunksAfterAbort = <C>(
  stream: ReadableStream<C>,
  signal: AbortSignal,
): ReadableStream<C> =>
  stream.pipeThrough(
    new TransformStream<C, C>({
      transform(chunk, controller) {
        if (signal.aborted) return;
        controller.enqueue(chunk);
      },
    }),
  );

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
  /** Active profile — decides which attachments travel native (C5). */
  modelProfile: ModelProfile;
  abortSignal?: AbortSignal;
  /**
   * Per-step hook forwarded to whichever agent serves the call, so the
   * caller can track `toolExecuted` / `visibleText` live (C4 failover).
   */
  onStepFinish?: GenerateTextOnStepEndCallback<ChatbotTools>;
  /**
   * Per-turn reasoning override (C7 "deep thinking"). When set, sent as
   * `providerOptions.openrouter.reasoning` to whichever agent serves the
   * call — it overrides the profile-baked default on the wire (the
   * provider merges call-time providerOptions over construction
   * settings). `undefined` → the baked default (byte-identical to today).
   */
  reasoningOverride?: ReturnType<typeof reasoningParamForProfile>;
}) => {
  const modelMessages = await convertToModelMessages(
    await prepareModelMessages(
      params.history,
      params.modelProfile,
      buildNativeInputDeps(params.callOptions.conversationId),
    ),
    // A turn aborted mid-tool-call (user Stop, tab close during a `python`
    // run) persists an assistant tool part still in `input-streaming` /
    // `input-available` — a tool call with no result. Sending it verbatim
    // makes the provider throw `MissingToolResultsError`, wedging the
    // conversation on every subsequent message. Dropping the incomplete
    // call is the SDK-sanctioned repair (covers static + dynamic tools).
    { ignoreIncompleteToolCalls: true },
  );
  // Primary → fallback failover (C4: transient errors earn one retry on
  // the SAME model before spending the fallback). Langfuse trace nesting +
  // attribute propagation are owned by the caller: `execute` (in
  // `runChatbotTurn`) wraps the whole turn in a single `chatbot-turn`
  // active span, so every `.stream()` here — and its nested tool /
  // sub-agent spans — attaches under that one trace.
  //
  // `servedBy` reports which agent actually answered: an eval run with a
  // candidate profile must know when a silent failover served the
  // FALLBACK model instead, or the candidate's scores are polluted.
  // Request-level OpenRouter options: the C7 reasoning override + the
  // C5v2 `file-parser` plugin (only when a native PDF rides this turn —
  // it pins the raw file past OpenRouter's default Mistral-OCR pass).
  // Omitted entirely when neither applies, so a plain turn sends no
  // `providerOptions` at all (byte-identical to pre-C7).
  const openrouterOptions = {
    ...(params.reasoningOverride !== undefined
      ? { reasoning: params.reasoningOverride }
      : {}),
    ...(hasNativeFileParts(params.history, params.modelProfile)
      ? { plugins: NATIVE_FILE_PARSER_PLUGINS }
      : {}),
  };
  const streamWith = (
    agent: AgentSet<ChatbotCallOptions, ChatbotTools>["primary"],
  ) =>
    agent.stream({
      messages: modelMessages,
      options: params.callOptions,
      abortSignal: params.abortSignal,
      onStepEnd: params.onStepFinish,
      ...(Object.keys(openrouterOptions).length > 0
        ? { providerOptions: { openrouter: openrouterOptions } }
        : {}),
    });
  const outcome = await streamWithRetryThenFallback({
    primary: () => streamWith(params.agentSet.primary),
    fallback: () => streamWith(params.agentSet.fallback),
    abortSignal: params.abortSignal,
    log: (message) => console.warn(`[chatbot] ${message}`),
  });
  // `modelMessages` is returned so the dead-step continuation can rebuild
  // "this turn so far" (base history + the partial turn's response messages)
  // without re-running `prepareModelMessages`.
  return { ...outcome, modelMessages };
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
 * `ai_messages.id` is a uuid column: only forward a wire id that is actually
 * a uuid (SDK-default 16-char ids from stale clients fall back to the DB
 * generating a v7 — same behaviour as before this column carried wire ids).
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string): boolean => UUID_RE.test(value);

const persistAssistantMessages = async (
  conversationId: string | undefined,
  history: UIMessage[],
  finalMessages: UIMessage[],
  turnId: string | null,
  tx?: Transaction,
): Promise<UIMessage[]> => {
  if (!conversationId) return [];
  const assistantMessages = filterNewAssistantMessages(history, finalMessages);
  if (assistantMessages.length === 0) return [];
  await saveMessages(
    conversationId,
    assistantMessages.map((m) => ({
      // Wire id preserved (uuid v7 minted by `generateMessageId`) — DB ids
      // stay identical to what the client already rendered, and the upsert
      // makes a recorder-then-onFinish double write converge in place.
      id: isUuid(m.id) ? m.id : undefined,
      role: "assistant" as const,
      parts: m.parts,
      metadata: narrowMessageMetadata(m),
      turnId,
    })),
    tx,
  );
  // The recorder writes under the WIRE id, and that id changes whenever the
  // turn merges a second `toUIMessageStream` (failover, dead-step
  // continuation). Its pre-rename row is never overwritten by the write above
  // and would surface as a duplicate assistant message holding a prefix of
  // these same parts. Scoped to this turn and to rows still marked partial.
  if (turnId !== null) {
    await deleteStalePartialMessages({
      conversationId,
      turnId,
      keepIds: assistantMessages.map((m) => m.id).filter(isUuid),
      tx,
    });
  }
  return assistantMessages;
};

/**
 * The `chat.turn` journal payload: enough for the memory pipeline to distill
 * an episode without reloading the conversation (previews + tools used), while
 * staying a few hundred bytes. Full text stays in `ai_messages`.
 */
const CHAT_TURN_USER_PREVIEW_MAX = 300;
const CHAT_TURN_ASSISTANT_PREVIEW_MAX = 500;

const buildChatTurnPayload = (
  history: UIMessage[],
  assistantMessages: UIMessage[],
  lastMessageId: string | undefined,
): Record<string, unknown> => {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const toolNames = new Set<string>();
  let assistantText = "";
  for (const m of assistantMessages) {
    for (const p of m.parts) {
      if (p.type === "dynamic-tool") toolNames.add(p.toolName);
      else if (p.type.startsWith("tool-"))
        toolNames.add(p.type.slice("tool-".length));
    }
    const text = uiMessageText(m);
    if (text.length > 0) assistantText = text;
  }
  return {
    ...(lastMessageId ? { lastMessageId } : {}),
    userMessagePreview: (lastUser ? uiMessageText(lastUser) : "").slice(
      0,
      CHAT_TURN_USER_PREVIEW_MAX,
    ),
    assistantPreview: assistantText.slice(0, CHAT_TURN_ASSISTANT_PREVIEW_MAX),
    toolNames: [...toolNames],
  };
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
  // Fired before the turn's own trace opens, so it is a sibling root like
  // `active-memory-recall` — named here, and joined to the conversation's
  // session so its cost lands with the turns it titles.
  return withNamedTrace(
    "conversation-title",
    {
      sessionId: params.conversationId,
      userId: params.callOptions.userId,
      tags: [`team:${params.callOptions.teamId}`],
    },
    () => generateConversationTitle(firstUserText, params.callOptions.teamId),
  );
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
    // A 404 here is the EXPECTED guard outcome, not a failure: the
    // membership-gated write refuses a conversation the caller can't see
    // (e.g. eval / never-persisted conversations). Skip silently.
    if (err instanceof HTTPException && err.status === 404) return;
    console.warn(
      `${params.logPrefix} auto-title emit failed:`,
      err instanceof Error ? err.message : err,
    );
  }
};

// Sensitive-input scrubbing lives in `lib/scrub-stream.ts` — shared with the
// workflow transcript pump so both wires redact the same tool inputs.

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
 * Build the input bundle for `runUnifiedRecall` from the
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
  const recentTail = buildRecallRecentTail(tailMessages);
  return { userMessage, attachedFiles, recentTail };
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
   * Thinking depth for this turn, already resolved and validated by the
   * caller (`effectiveReasoningLevel`): the user's pick in the prompt
   * bar, else the team's stored default for this model. Absent → the
   * profile's own default, which keeps the turn byte-identical to one
   * where nobody chose. Internal `/invoke` callers always omit it.
   */
  reasoningLevel?: ReasoningLevel;
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
 * Per-turn external-app setup — shared with the workflow handler, extracted
 * to `agents/shared/fragments.ts`. This thin adapter maps the chatbot's
 * per-turn param bag onto the shared signature.
 */
const loadChatbotExternalApps = (
  params: RunChatbotTurnParams,
): Promise<{
  externalAppConnections: ChatbotCallOptions["externalAppConnections"];
  externalAppsBlock: string | undefined;
}> =>
  loadExternalApps({
    conversationId: params.conversationId,
    organizationId: params.callOptions.organizationId,
    teamId: params.callOptions.teamId,
    userId: params.callOptions.userId,
    turnId: params.callOptions.traceId,
    logPrefix: params.logPrefix,
  });

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
  // The three scope-based fragments (context manifest, team objects, skills)
  // are assembled by the shared `assembleContextFragments` — same soft
  // timeouts and soft-fail semantics as the historical inline version (C4:
  // HANG backstops, not latency caps). The two history-dependent fragments
  // (attached files, active-memory recall) stay here and run in the same
  // parallel batch.
  const [attachedFilesBlock, activeMemoryRecall, fragments, toolPolicies] =
    await Promise.all([
      // Conversation-scoped, NOT last-message-scoped: a file part that the
      // active profile can't ingest natively is dropped from the history by
      // `prepareModelMessages` (and native ones past the recency cap with
      // it), so this block is the ONLY thing that keeps an earlier turn's
      // attachment knowable. Scoping it to the last user message made every
      // such file vanish on turn 2 — the agent then reports it has no files
      // while they sit readable in `attachments/`. Same builder the workflow
      // handler uses.
      withSoftTimeout(
        buildConversationAttachedFilesBlock(params.conversationId),
        4000,
        ATTACHED_FILES_UNAVAILABLE,
        "attached-files",
      ),
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
              withSoftTimeout(
                runUnifiedRecall({
                  userMessage: activeMemoryInputs.userMessage,
                  attachedFiles: activeMemoryInputs.attachedFiles,
                  recentTail: activeMemoryInputs.recentTail,
                  teamId: params.callOptions.teamId,
                  organizationId: params.callOptions.organizationId,
                  userId: activeMemoryUserId,
                  conversationId: params.conversationId,
                  agentType: "chatbot",
                }),
                // ABOVE the recall's own 15s judge budget (RECALL_TIMEOUT_MS)
                // + RAG headroom — only fires on a true RAG hang, never on a
                // normal (multi-second) judge generation.
                18000,
                null,
                "active-memory",
              ),
          )
        : Promise.resolve(null),
      assembleContextFragments({
        organizationId: params.callOptions.organizationId,
        teamId: params.callOptions.teamId,
        userId: params.callOptions.userId,
        logPrefix: params.logPrefix,
      }),
      getTeamToolPolicies(params.callOptions.teamId),
    ]);

  console.info(
    `${params.logPrefix} contextManifestChars=${(fragments.chatbotContextManifest ?? "").length.toString()} activeMemory=${activeMemoryRecall ? "hit" : "miss"} teamCollectionsChars=${(fragments.teamCollectionsBlock ?? "").length.toString()} enabledSkillsChars=${(fragments.enabledSkillsBlock ?? "").length.toString()}`,
  );

  return {
    ...params.callOptions,
    attachedFilesBlock:
      attachedFilesBlock.length > 0 ? attachedFilesBlock : undefined,
    chatbotContextManifest: fragments.chatbotContextManifest,
    activeMemoryBlock: activeMemoryRecall?.block,
    availableCapabilitiesBlock: activeMemoryRecall?.capabilityBlock,
    teamCollectionsBlock: fragments.teamCollectionsBlock,
    enabledSkillsBlock: fragments.enabledSkillsBlock,
    externalAppConnections: externalApps.externalAppConnections,
    externalAppsBlock: externalApps.externalAppsBlock,
    toolPolicies,
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
  // Non-resumable callers (stateless /internal/invoke) have no Stop channel.
  if (params.resumableStreamId === undefined) {
    return { abortController, releaseAbortSubscriber: async () => undefined };
  }
  const streamId = params.resumableStreamId;
  const { release } = await subscribeAbort(getAbortChannel(streamId), () => {
    console.info(
      `${params.logPrefix} stop signal received streamId=${streamId}`,
    );
    abortController.abort();
  });
  return { abortController, releaseAbortSubscriber: release };
};

/**
 * C4 — mid-stream failure escalation across turns. When a turn dies
 * mid-stream with a structured (non-transparent) error, we drop a
 * short-lived marker keyed by conversation. The client's retry is a plain
 * re-POST with no resume signal (`ChatStreamRequestSchema` carries no
 * retry field), so without this the next attempt re-runs the SAME primary
 * on the SAME context and dies identically — exactly the loop observed in
 * prod (two identical mid-stream deaths on a 71k-token turn). The next
 * turn consumes the marker once and serves the fallback model.
 *
 * MULTI-REPLICA: the `ai` service runs as N horizontally-scaled replicas,
 * so turn N (which SETs the marker) and its retry turn N+1 (which reads
 * it) may land on DIFFERENT instances. The marker therefore lives in the
 * shared Redis, not in process memory. `GETDEL` is atomic, so the
 * escalation fires exactly once even if two retries race across two
 * replicas — the loser reads null and simply stays on the primary. The
 * 15-min TTL bounds the blast radius: a one-off provider blip escalates at
 * most the immediately-following turn, then the key self-expires (no
 * explicit clear needed — GETDEL-at-start already consumes it).
 */
const MIDSTREAM_ERROR_MARKER_TTL_SECONDS = 900;
const midstreamErrorMarkerKey = (conversationId: string): string =>
  `chatbot:midstream-error:${conversationId}`;

/** Record that this conversation's turn just died mid-stream. Fire-and-forget. */
const markMidstreamError = (conversationId: string, reason: string): void => {
  void redis
    .set(
      midstreamErrorMarkerKey(conversationId),
      reason,
      "EX",
      MIDSTREAM_ERROR_MARKER_TTL_SECONDS,
    )
    .catch((err: unknown) => {
      console.warn("[chatbot] failed to set mid-stream error marker:", err);
    });
};

/**
 * Read-and-delete the mid-stream error marker for a conversation. Returns
 * true when a prior turn (possibly on another replica) died mid-stream (→
 * serve the fallback this turn). GETDEL is atomic, so the escalation fires
 * exactly once across replicas.
 */
const consumeMidstreamErrorMarker = async (
  conversationId: string,
): Promise<boolean> => {
  try {
    const prior = await redis.getdel(midstreamErrorMarkerKey(conversationId));
    return prior !== null;
  } catch (err: unknown) {
    console.warn("[chatbot] failed to consume mid-stream error marker:", err);
    return false;
  }
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
 * Turn-log transport: when a `streamId` was claimed by the caller, the
 * chunk stream is pumped into a per-turn Redis Stream (`turn-log.ts`)
 * and every consumer — this POST included — reads the log back with a
 * cursor. The `onFinish` callback clears the `activeStreamId` column so
 * the GET /:conversationId/stream reconnection handler knows the turn
 * is done. We intentionally do NOT forward the request AbortSignal to
 * the LLM — the turn must finish regardless of whether any HTTP client
 * is still connected so `onFinish` can persist the assistant messages
 * and the log stays consistent.
 *
 * Intentionally NOT a middleware: the two routes have distinct
 * pre-work (Better Auth session vs X-Context headers, user-message
 * persistence only on /stream, …). Factoring the shared tail keeps
 * the two routes aligned without flattening their differences.
 */
export const runChatbotTurn = async (
  params: RunChatbotTurnParams,
): Promise<Response> => {
  const filenames = extractLastUserFileFilenames(params.history);
  const tooManyFiles = await rejectTooManyFiles(params, filenames);
  if (tooManyFiles) {
    return tooManyFiles;
  }

  /**
   * The usage ledger's key, and NOT `getActiveTraceId()`.
   *
   * Two different identifiers call themselves a trace id here. This one is
   * the runtime context's — the resumable `streamId`, threaded into every
   * agent and suffixed by every delegate (`.page`, `.sub`), which is what
   * `recordStepUsage` writes under. `getActiveTraceId()` is the Langfuse
   * span context, 32 hex characters from a different namespace.
   *
   * Reading with the wrong one is silent: `readTurnUsage` answers
   * `undefined` and the metadata simply omits the spend. The first version
   * of this ledger shipped that way on 2026-09-06 — counted on every step,
   * never once read back — and the only thing that caught it was the eval
   * runner printing "server ledger absent" instead of a cost.
   */
  const usageKey = params.callOptions.traceId;

  // Context files are NOT hydrated here. `read("context/...")` serves
  // them Bun-side (no sandbox), and the `python` / `bash` tools hydrate
  // them into `/workspace/context/...` on demand via
  // `prepareSandboxForCode` — so a turn that never runs code skips
  // sandbox acquisition entirely. Chat attachments + outputs come back
  // automatically when the storage façade restores from S3 on first
  // sandbox access.

  // External apps: active connections (surfaced to the agent) + a fresh
  // per-turn sandbox JWT for `fretik_apps`. See loadExternalApps.
  const externalApps = await loadChatbotExternalApps(params);

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
  let agentSet = params.agentSet ?? defaultChatbotAgentSet();
  let modelProfile = params.modelProfile ?? getProfileForRole("chat");

  // C4 — escalate to the fallback model when the PREVIOUS attempt on this
  // conversation died mid-stream (marker set by `recordStreamError`). Only
  // on the default user path: an explicit /invoke pin (eval gate, workers)
  // must stay on its candidate model, so a caller-supplied `agentSet` is
  // never overridden. Serving the fallback swaps BOTH the agent AND the
  // profile so compaction threshold / native-input policy / metadata key
  // all follow the model that actually answers.
  const escalatedAfterMidstreamError =
    params.agentSet === undefined &&
    params.conversationId !== undefined &&
    (await consumeMidstreamErrorMarker(params.conversationId));
  if (escalatedAfterMidstreamError) {
    console.warn(
      `${params.logPrefix} prior turn died mid-stream — escalating to fallback model`,
    );
    agentSet = { ...agentSet, primary: agentSet.fallback };
    modelProfile = getProfileForRole("chat-fallback");
  }

  // Which attachments actually ride native this turn, and which the model has
  // to open with a tool. Computed HERE because the fallback escalation above
  // can still change the profile — and the profile decides. Set on the options
  // object, which is not read until the stream calls below.
  callOptionsWithFiles.nativeIngestion = planNativeIngestion(
    params.history,
    modelProfile,
  );

  // C7 — per-turn "deep thinking" reasoning override. Built once from the
  // turn's level + the SAME profile that serves it, so the primary stream
  // AND the zombie/transparent-failover path request the same depth.
  // `undefined` when the toggle is off (→ profile default, byte-identical
  // to pre-C7) or when the profile does not reason (reasoningParamForProfile
  // returns undefined for `style: "none"`).
  const reasoningOverride =
    params.reasoningLevel === undefined
      ? undefined
      : reasoningParamForProfile(modelProfile, params.reasoningLevel);

  // C4 turn-robustness state. `onError` (sync, fires on the wire when the
  // stream errors) and the recovery seam inside `execute` below reach the
  // SAME verdict from these flags + `classifyStreamError`, so they never
  // contradict. The flags are advanced live by `onTurnStep`, forwarded to
  // every `.stream()` call as `onStepFinish`.
  const turnFlags = {
    toolExecuted: false,
    visibleText: false,
    failoverAttempted: false,
    // Final-step signals for the dead-final-step recovery (the model
    // announces an action, then ends the turn without the tool call).
    // Overwritten every step, so at turn end they describe the LAST step.
    lastStepCalledTool: false,
    lastStepVisibleChars: 0,
  };
  // Langfuse anchor for the turn, captured the moment the `chatbot-turn`
  // span opens. `recordStreamError` fires inside stream callbacks where
  // the OTel async context is NOT guaranteed — the explicit spanContext
  // lets it attach an ERROR event to the right trace deterministically,
  // and `traceId` rides the structured error frame so a dead turn stays
  // traceable from the client / eval harness (Bug: errored turns had no
  // Langfuse observation and no captured traceId at all).
  const turnTrace: {
    traceId?: string;
    spanContext?: SpanContext;
    /** First fatal/structured classification put on the wire, for the parent span. */
    errorStatus?: string;
  } = {};
  // Wire-error dedup. The AI SDK's outer `createUIMessageStream` re-invokes
  // `onError(new Error(chunk.errorText))` for every merged error chunk — so
  // `recordStreamError` runs a SECOND time with an Error whose message is
  // the very string it already returned (the structured JSON, the sentinel,
  // "Stopped."). Without this guard that second pass re-classifies the
  // derivative (→ a bogus fatal/unknown), double-logs, and duplicates the
  // Langfuse `turn-error` event. Every value we put on the wire is recorded
  // here; a re-entry that matches short-circuits with zero side effects.
  //
  // Process-local by design (NOT Redis): both onError callbacks belong to
  // the SAME `createUIMessageStream` and fire in the same tick on the one
  // replica that owns this turn. A turn never splits across instances (a
  // GET reconnect only replays the Redis buffer, it does not re-run the
  // turn), so there is nothing to synchronise cross-replica here.
  const emittedWireErrors = new Set<string>();
  const onTurnStep: GenerateTextOnStepEndCallback<ChatbotTools> = (step) => {
    const calledTool = step.toolCalls.length > 0 || step.toolResults.length > 0;
    if (calledTool) turnFlags.toolExecuted = true;
    if (step.text.length > 0) turnFlags.visibleText = true;
    turnFlags.lastStepCalledTool = calledTool;
    turnFlags.lastStepVisibleChars = step.text.trim().length;
  };
  // A stream error is "transparently recoverable" only when it is a
  // pre-output provider failure (empty pool / 429 / 5xx / timeout), no
  // tool ran, nothing visible was streamed, and we haven't already spent
  // the failover. Then re-streaming the fallback can't duplicate text or
  // repeat a side effect.
  const isTransparentFailure = (err: unknown): boolean =>
    !turnFlags.toolExecuted &&
    !turnFlags.visibleText &&
    !turnFlags.failoverAttempted &&
    isTransparentlyRecoverable(classifyStreamError(err));
  // Map a stream error onto the wire. Transparent failures return the
  // sentinel (the recovery seam re-streams the fallback; the eval harness
  // and the chat client treat it as a no-op). Everything else returns a
  // structured retryable error the client renders with a one-click retry;
  // `resume` tells it to CONTINUE the turn (a tool already ran — replaying
  // would repeat the side effect) rather than regenerate from scratch.
  const recordStreamError = (err: unknown): string => {
    // Second-pass short-circuit (see `emittedWireErrors`): the outer stream
    // re-enters this handler with `new Error(<string we already returned>)`.
    // Return it verbatim — no re-classification, no log, no duplicate event.
    if (err instanceof Error && emittedWireErrors.has(err.message)) {
      return err.message;
    }
    const emit = (value: string): string => {
      emittedWireErrors.add(value);
      return value;
    };
    if (abortController.signal.aborted) {
      console.info(`${params.logPrefix} stream ended after user abort`);
      return emit("Stopped.");
    }
    // A bad tool input / unknown tool is NOT a turn death: the SDK already fed
    // it back to the model as a recoverable tool-error part (multi-step). Label
    // the UI part and let the turn continue — never a structured fatal frame.
    if (isRecoverableToolCallError(err)) {
      console.info(
        `${params.logPrefix} recoverable tool-call error (${err instanceof Error ? err.name : "unknown"}) — model self-corrects`,
      );
      return emit("Invalid tool input — adjust the arguments and retry.");
    }
    const classification = classifyStreamError(err);
    // Log the full error OBJECT (stack + cause chain) — a name/message
    // string is not enough to root-cause a mid-stream validation error.
    console.error(
      `${params.logPrefix} mid-stream ${classification.kind}/${classification.reason}:`,
      err,
    );
    const transparent = isTransparentFailure(err);
    // Land the raw error on the Langfuse trace: a WARNING event when the
    // failover absorbs it transparently, an ERROR event when a structured
    // frame reaches the wire. Without this, an errored turn has zero
    // ERROR observation and every debug session restarts from the dev
    // console. Point-in-time event, parented explicitly (see turnTrace).
    if (turnTrace.spanContext !== undefined) {
      startObservation(
        "turn-error",
        {
          level: transparent ? "WARNING" : "ERROR",
          statusMessage: `${classification.kind}/${classification.reason}`,
          input: describeStreamError(err),
          metadata: {
            reason: classification.reason,
            kind: classification.kind,
            transparentFailover: String(transparent),
          },
        },
        { asType: "event", parentSpanContext: turnTrace.spanContext },
      );
    }
    if (transparent) return emit(FAILOVER_SENTINEL);
    turnTrace.errorStatus ??= `${classification.kind}/${classification.reason}`;
    // Mark the conversation so the NEXT turn (the user's retry — possibly on
    // another replica) escalates to the fallback model instead of dying the
    // same way on the same primary. Skipped for pinned callers (no
    // conversationId, or a caller-supplied agentSet — eval gate / workers).
    if (params.conversationId !== undefined && params.agentSet === undefined) {
      markMidstreamError(params.conversationId, classification.reason);
    }
    return emit(
      JSON.stringify(
        toStructuredError(classification, {
          resume: turnFlags.toolExecuted,
          ...(turnTrace.traceId !== undefined
            ? { traceId: turnTrace.traceId }
            : {}),
        }),
      ),
    );
  };

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

  // Post-turn bookkeeping nothing downstream waits on: closing the Stop
  // channel, shipping the turn's spans, dropping the in-process usage ledger.
  // Kept OFF the client's end-of-turn path on purpose. `onFinish` runs inside
  // the SDK stream's `flush()`, so the stream — and with it the turn log's end
  // marker, hence the client's `[DONE]` — waits for everything awaited in it.
  // With the Langfuse flush (unbounded network I/O) in there, a finished
  // answer sat on screen for seconds with the composer still on Stop. The
  // turn-log path runs this after the pump wrote the end marker; the
  // stateless `/internal/invoke` path (no pump) runs it at the end of
  // `onFinish`. Idempotent and self-catching: it is reached from both.
  let settled = false;
  const settleTurn = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await releaseAbortSubscriber();
      await flushLangfuse();
    } catch (err) {
      console.warn(
        `${params.logPrefix} post-turn settle failed:`,
        err instanceof Error ? err.message : err,
      );
    } finally {
      // The durable copies (the version row, the turn observation, the
      // message metadata) are all written by now; dropping the ledger keeps
      // a long-lived process from carrying every turn it ever served.
      forgetTurnUsage(usageKey);
    }
  };

  const rawStream = createUIMessageStream<UIMessage>({
    originalMessages: params.history,
    // uuid v7 for any message id the outer stream mints itself — keeps
    // every id in the turn a valid uuid so persistence preserves it.
    generateId: randomUUIDv7,
    // C4 — mid-stream errors. The primary→fallback try/catch in
    // `streamChatbotWithFallback` only catches errors BEFORE the stream
    // is set up; anything that errors after `.stream()` returns reaches
    // this callback (and the inner `toUIMessageStream` onError). Both
    // delegate to `recordStreamError`: a transparent pre-output failure
    // is swallowed (the recovery seam re-streams the fallback), every
    // other error becomes a structured retryable frame.
    onError: recordStreamError,
    onFinish: async ({ messages: finalMessages }) => {
      // ORDER IS THE CONTRACT HERE, and it is NOT the workflow handler's
      // (`handlers/workflow.ts` ends the log BEFORE clearing the slot — it
      // can, because it force-sets the id and never 409s). Two invariants:
      //
      //  - The client's `[DONE]` must never precede the slot release, or the
      //    prompt a user types the instant the answer lands takes a 409.
      //    `onFinish` runs inside the SDK stream's `flush()` and the log's
      //    end marker is written after the stream closes, so everything
      //    awaited here already happens first. The flip side is that
      //    everything awaited here DELAYS `[DONE]`, which is why the slow
      //    bookkeeping moved to `settleTurn` (see its docblock).
      //  - The slot release and `turn-ended` must run even when persistence
      //    throws. Nothing retries the persistence, so a slot held after a
      //    failed write buys nothing and costs a 409 on every later prompt
      //    plus a background-task resume that can never fire (the sweep
      //    requires a null slot). The recorder's trailing flush has already
      //    left this turn's `partial` rows in history, which is what an
      //    interrupted turn is supposed to show.
      let persistError: unknown;
      // Persist the turn's messages AND journal its `chat.turn` boundary in
      // ONE transaction — the outbox guarantee (both commit or neither). The
      // event feeds memory recall + future workflow triggers; dedup-keyed on
      // the final message id so a re-fired `onFinish` never double-journals.
      // Payload carries previews + tool names so the distiller can build an
      // episode without reloading the turn.
      try {
        await db.transaction(async (tx) => {
          const persisted = await persistAssistantMessages(
            params.conversationId,
            params.history,
            finalMessages,
            params.resumableStreamId ?? null,
            tx,
          );
          if (!params.conversationId) return;
          const lastMessageId = finalMessages[finalMessages.length - 1]?.id;
          await emitDomainEvent({
            tx,
            organizationId: params.callOptions.organizationId,
            teamId: params.callOptions.teamId,
            type: "chat.turn",
            actor: {
              actorType: "agent",
              actorUserId: params.callOptions.userId ?? null,
              conversationId: params.conversationId,
              agentKey: "chatbot",
            },
            payload: buildChatTurnPayload(
              params.history,
              persisted,
              lastMessageId,
            ),
            dedupKey: lastMessageId ? `chat.turn:${lastMessageId}` : null,
          });
        });
      } catch (err) {
        // Rethrown at the very end — the teardown below runs first.
        persistError = err;
        console.error(
          `${params.logPrefix} turn persistence failed — tearing the turn down anyway:`,
          err instanceof Error ? err.message : err,
        );
      }
      // Release the active-stream slot so the next turn can start without
      // tripping the 409 idempotence guard. Compare-and-swap on the streamId
      // keeps us safe from clearing a fresher turn.
      if (params.conversationId && params.resumableStreamId) {
        await clearConversationActiveStream(
          params.conversationId,
          params.resumableStreamId,
        );
        // Tell every connected viewer the shared turn is over: stop the
        // live fan-out + lift the send gate. `stopped` flags a user Stop
        // so viewers render the same "Stopped" affordance on the partial.
        await publishConversationEvent(params.conversationId, {
          type: "turn-ended",
          streamId: params.resumableStreamId,
          stopped: abortController.signal.aborted,
        });
      }
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
      // Drain background work that finished while this turn held the slot: a
      // resume needs a free slot, which only exists now. Goes through the
      // same signal as every other terminal path (rather than calling the
      // resume directly, which would make this handler and the resume service
      // import each other) — this process is subscribed, so it comes straight
      // back. Gated on the registry so idle conversations publish nothing.
      if (params.conversationId) {
        const conversationId = params.conversationId;
        void hasResumableConversationTasks(conversationId)
          .then(async (owed) => {
            if (owed) await publishConversationTaskResume(conversationId);
          })
          .catch((err: unknown) => {
            console.warn(
              `${params.logPrefix} background-task drain failed:`,
              err instanceof Error ? err.message : err,
            );
          });
      }
      // A turn-log turn settles AFTER its pump wrote the end marker (see the
      // `.finally` on `pumpChunksToTurnLog` below) so the client's `[DONE]`
      // never waits on a Langfuse flush. A stateless `/internal/invoke` turn
      // has no pump, so here is its only chance.
      if (params.resumableStreamId === undefined) {
        await settleTurn();
      }
      // Surface the persistence failure now that the turn is torn down. The
      // pump marks the log `r=error`, and readers emit `[DONE]` on any end
      // marker — so the client still ends cleanly and can send again.
      if (persistError !== undefined) throw persistError;
    },
    execute: async ({ writer }) => {
      // Trace I/O for the `chatbot-turn` parent span (set inside the
      // active-observation context below). Captured by `turnBody`.
      let visibleOutput = "";
      let traceFinishReason: string | undefined;
      // Recovery telemetry folded onto the `chatbot-turn` observation so a
      // failover is filterable in Langfuse (the model spans are all named
      // `agent:chatbot`, indistinguishable on their own). `servedByTurn`
      // = which agent produced the visible answer; `recoveryKind` = how the
      // turn was rescued (undefined = clean); `recoveryErrorReason` = the
      // classified cause when a stream error drove the recovery.
      let servedByTurn: "primary" | "fallback" = "primary";
      let recoveryKind: string | undefined;
      let recoveryErrorReason: string | undefined;

      // Stream the fallback model into the SAME writer and fold its
      // result into the turn's trace. Shared by two callers: zombie
      // recovery (primary finished empty → `notice: true`, a visible
      // "switching…" line) and C4 transparent failover (primary errored
      // pre-output → `notice: false`, silent). Sets `failoverAttempted`
      // so a subsequent fallback error surfaces as a structured error
      // instead of being swallowed as a second (impossible) failover.
      const runFallbackModel = async (
        historyForModel: UIMessage[],
        opts: { notice: boolean; recovery: string },
      ): Promise<void> => {
        turnFlags.failoverAttempted = true;
        servedByTurn = "fallback";
        recoveryKind = opts.recovery;
        try {
          if (opts.notice) {
            const noticeId = randomUUIDv7();
            // All three chunks MUST carry the same id: `processUIMessageStream`
            // throws `UIMessageStreamError` on a `text-delta` whose id has no
            // open `text-start`, which kills the whole client stream — no
            // notice, no `onFinish`, turn never persisted.
            writer.write({ type: "text-start", id: noticeId });
            writer.write({
              type: "text-delta",
              id: noticeId,
              delta:
                "_Switching to the fallback model after the primary stopped without producing an answer…_\n\n",
            });
            writer.write({ type: "text-end", id: noticeId });
          }
          const fallbackMessages = await convertToModelMessages(
            await prepareModelMessages(
              historyForModel,
              modelProfile,
              buildNativeInputDeps(callOptionsWithFiles.conversationId),
            ),
            // Same dangling-tool-call guard as the primary path above — an
            // interrupted turn's incomplete tool call must not reach the
            // model as a resultless call (MissingToolResultsError).
            { ignoreIncompleteToolCalls: true },
          );
          const fallbackResult = await agentSet.fallback.stream({
            messages: fallbackMessages,
            options: callOptionsWithFiles,
            abortSignal: abortController.signal,
            onStepEnd: onTurnStep,
            // Mirror the primary path's per-turn reasoning depth (C7).
            ...(reasoningOverride !== undefined
              ? {
                  providerOptions: {
                    openrouter: { reasoning: reasoningOverride },
                  },
                }
              : {}),
          });
          writer.merge(
            dropChunksAfterAbort(
              toUIMessageStream<ChatbotTools>({
                stream: fallbackResult.stream,
                // uuid v7 wire ids — persisted verbatim by `saveMessages`
                // so DB ids ≡ stream ids (stable Vue keys across reloads).
                generateMessageId: randomUUIDv7,
                onError: recordStreamError,
                messageMetadata: ({ part }) => {
                  if (part.type !== "finish") return undefined;
                  // Failover (zombie or transparent) always serves the fallback
                  // agent — flagged for the eval harness.
                  return buildTurnMessageMetadata(
                    part,
                    "fallback",
                    modelProfile.key,
                    getActiveTraceId(),
                    readTurnUsage(usageKey),
                  );
                },
              }),
              abortController.signal,
            ),
          );
          const [fbFinish, fbText] = await Promise.all([
            fallbackResult.finishReason,
            fallbackResult.text,
          ]);
          // The fallback produced the actually-visible answer — make it the
          // trace output instead of the primary's empty/partial text.
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
            // Same id across the three chunks — see the note on the notice above.
            writer.write({ type: "text-start", id: finalId });
            writer.write({
              type: "text-delta",
              id: finalId,
              delta:
                "Both models stopped without producing an answer. Please retry — for large attachments, try opening the file directly in `python` (e.g. `pdfplumber.open(...)`, `pd.read_csv(...)`).",
            });
            writer.write({ type: "text-end", id: finalId });
          }
        } catch (err) {
          // The fallback chain failed too (pre-stream throw, or its own
          // pre-output error rejecting the result promises). `recordStreamError`
          // already put a structured retryable error on the wire; partials
          // persist via `onFinish`. Log and let the turn close gracefully.
          console.warn(
            `${params.logPrefix} fallback-model chain failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      };

      // Dead-final-step recovery: the model did tool work, then its FINAL
      // step announced an action in a short text and emitted EOS instead of
      // the tool call (MiniMax "understanding-execution gap" — prod zombies
      // 2026-07-22/23). Unlike the zombie path above, the turn HAS side
      // effects, so re-running it from the base history would replay tool
      // writes (a `create_draft` would be duplicated). The remedy is a
      // CONTINUATION: same turn context (base model messages + the partial
      // turn's response messages) plus a one-line steer, streamed into the
      // same writer. One attempt on the primary; if its final step dies the
      // same way, one attempt on the fallback model with the identical
      // augmented history; then give up (the announced text stays visible).
      const CONTINUATION_NUDGE =
        "[continuation] Your last message announced an action but the turn ended without the corresponding tool call. Continue now: make that tool call and carry the task through. If the work is genuinely complete, write the final answer instead.";
      /** Final-step text at/above this length reads as a real answer, not a
       * dead announcement (observed dead steps: 86 and 396 chars). */
      const DEAD_STEP_TEXT_CEILING = 600;
      const runContinuation = async (
        baseMessages: ModelMessage[],
        partialMessages: ModelMessage[],
      ): Promise<void> => {
        turnFlags.failoverAttempted = true;
        const messages = [
          ...baseMessages,
          ...partialMessages,
          { role: "user" as const, content: CONTINUATION_NUDGE },
        ];
        const attempt = async (
          agent: AgentSet<ChatbotCallOptions, ChatbotTools>["primary"],
          kind: string,
          servedBy: "primary" | "fallback",
        ): Promise<boolean> => {
          recoveryKind = kind;
          if (servedBy === "fallback") servedByTurn = "fallback";
          const contResult = await agent.stream({
            messages,
            options: callOptionsWithFiles,
            abortSignal: abortController.signal,
            onStepEnd: onTurnStep,
            ...(reasoningOverride !== undefined
              ? {
                  providerOptions: {
                    openrouter: { reasoning: reasoningOverride },
                  },
                }
              : {}),
          });
          writer.merge(
            dropChunksAfterAbort(
              toUIMessageStream<ChatbotTools>({
                stream: contResult.stream,
                generateMessageId: randomUUIDv7,
                onError: recordStreamError,
                messageMetadata: ({ part }) => {
                  if (part.type !== "finish") return undefined;
                  return buildTurnMessageMetadata(
                    part,
                    servedBy,
                    modelProfile.key,
                    getActiveTraceId(),
                    readTurnUsage(usageKey),
                  );
                },
              }),
              abortController.signal,
            ),
          );
          const [contFinish, contText] = await Promise.all([
            contResult.finishReason,
            contResult.text,
          ]);
          visibleOutput = [visibleOutput, contText ?? ""]
            .filter((s) => s.length > 0)
            .join("\n");
          // Recovered iff the continuation's final step either ran a tool
          // (flags updated live by onTurnStep) or delivered substantial text.
          return (
            turnFlags.lastStepCalledTool ||
            (contFinish === "stop" &&
              turnFlags.lastStepVisibleChars >= DEAD_STEP_TEXT_CEILING)
          );
        };
        try {
          console.error(
            `${params.logPrefix} dead final step (announced action, no tool call) — continuing on the primary`,
          );
          if (
            await attempt(agentSet.primary, "dead-step-continuation", "primary")
          ) {
            return;
          }
          console.error(
            `${params.logPrefix} continuation died on the primary — retrying on the fallback model`,
          );
          await attempt(
            agentSet.fallback,
            "dead-step-continuation-fallback",
            "fallback",
          );
        } catch (err) {
          console.warn(
            `${params.logPrefix} dead-step continuation failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      };

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
          // Summariser honours the team's workhorse pick (C8b).
          teamId: params.callOptions.teamId,
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

        const { result, servedBy, retried, modelMessages } =
          await streamChatbotWithFallback({
            history: historyForModel,
            callOptions: callOptionsWithFiles,
            agentSet,
            modelProfile,
            abortSignal: abortController.signal,
            onStepFinish: onTurnStep,
            reasoningOverride,
          });
        // Pre-stream recovery telemetry (the mid-stream paths set their own
        // `recoveryKind` via runFallbackModel / the structured-error branch).
        servedByTurn = servedBy;
        if (servedBy === "fallback") {
          recoveryKind = retried
            ? "retry-then-fallback"
            : "pre-stream-fallback";
        } else if (retried) {
          recoveryKind = "retry-same-model";
        }

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
          dropChunksAfterAbort(
            toUIMessageStream<ChatbotTools>({
              stream: result.stream,
              generateMessageId: randomUUIDv7,
              // A provider `error` part (e.g. empty pool) surfaces through
              // the INNER stream's onError, not the outer one — route it to
              // the same mapper so both surfaces agree on the wire frame.
              onError: recordStreamError,
              messageMetadata: ({ part }) => {
                if (part.type !== "finish") return undefined;
                // `servedBy` reports which agent answered under which profile;
                // the eval harness reads it over SSE so a silent failover to
                // the fallback model is flagged, not scored as the candidate.
                // `getActiveTraceId()` is this turn's active span, sent live AND
                // persisted so the feedback control scores the right trace.
                return buildTurnMessageMetadata(
                  part,
                  servedBy,
                  modelProfile.key,
                  getActiveTraceId(),
                  readTurnUsage(usageKey),
                );
              },
            }),
            abortController.signal,
          ),
        );

        // Post-merge recovery (C4 + zombie). Awaiting the primary's
        // aggregate promises RESOLVES on a completed turn (happy path or
        // zombie) and REJECTS when the stream errored before any step
        // completed — `recordedSteps === 0` in the SDK, i.e. a pre-output
        // provider failure (empty pool / 429 / 5xx). We branch on that.
        let resolved: [string, string] | undefined;
        let streamRejection: unknown;
        try {
          resolved = await Promise.all([result.finishReason, result.text]);
        } catch (err) {
          streamRejection = err;
        }

        if (abortController.signal.aborted) {
          // User clicked Stop — nothing to recover.
        } else if (resolved === undefined) {
          // Pre-output stream error. `recordStreamError` already mapped it
          // onto the wire (the FAILOVER_SENTINEL when transparent, else a
          // structured retryable error). When transparent, re-stream the
          // fallback into the same writer — silent, because the primary
          // produced nothing visible and ran no tool.
          const classification = classifyStreamError(streamRejection);
          recoveryErrorReason = classification.reason;
          if (isTransparentFailure(streamRejection)) {
            console.error(
              `${params.logPrefix} pre-output ${classification.reason} — transparent failover to fallback model`,
            );
            await runFallbackModel(historyForModel, {
              notice: false,
              recovery: "transparent-failover",
            });
          } else {
            // Fatal, or a mid-stream socket drop (recovered by the
            // resumable-stream reconnect, not a model swap), or the
            // failover was already spent. The structured error is on the
            // wire; partial messages persist via `onFinish`. Log only.
            recoveryKind = "structured-error";
            console.error(
              `${params.logPrefix} pre-output ${classification.kind}/${classification.reason} — structured retryable error on the wire:`,
              streamRejection,
            );
          }
        } else {
          // Stream completed ≥1 step: happy path or zombie. A post-tool
          // mid-stream error that resolved with a partial already had its
          // structured frame emitted by `recordStreamError`; partials
          // persist via `onFinish`, so there is nothing extra to do here.
          const [finishReason, finalText] = resolved;
          // Trace output for `chatbot-turn`: the primary's visible answer
          // (overridden inside runFallbackModel if its fallback answers).
          visibleOutput = finalText ?? "";
          traceFinishReason = finishReason;
          const isBudgetExhausted =
            finishReason === "other" || finishReason === "length";
          const hasNoVisibleText = (finalText ?? "").trim().length === 0;
          // Zombie: the turn finished with no answer AND no tool side effect
          // (reasoning-only stop, or a budget-exhausted step — observed on
          // MiniMax M3, doctrine run 2026-07-17). Chain the fallback from the
          // base history: with zero side effects a from-scratch re-run is
          // safe. Turns that ran a tool are EXCLUDED here — re-running them
          // would replay their writes; their dead-step case is handled by the
          // continuation below, which keeps the partial turn in context.
          const primaryZombied =
            (isBudgetExhausted || finishReason === "stop") &&
            !turnFlags.toolExecuted &&
            hasNoVisibleText;
          // Dead final step: the turn DID tool work, then its final step
          // announced an action in a short text and finished without the
          // tool call (MiniMax "understanding-execution gap", prod zombies
          // 2026-07-22/23 — 86 and 396 chars of "let me…" then EOS; the
          // reasoning volume is NOT a signal, the observed cases spanned
          // 879→17k reasoning tokens). The judge separates it from a
          // legitimate brief answer; askUserQuestion / pending-approval
          // turns never match (their final step calls a tool).
          const deadFinalStep =
            (finishReason === "stop" || isBudgetExhausted) &&
            turnFlags.toolExecuted &&
            !turnFlags.lastStepCalledTool &&
            turnFlags.lastStepVisibleChars < DEAD_STEP_TEXT_CEILING &&
            !turnFlags.failoverAttempted;
          if (primaryZombied) {
            console.error(
              `${params.logPrefix} primary zombied (finish=${finishReason}) — chaining to fallback model`,
            );
            await runFallbackModel(historyForModel, {
              notice: true,
              recovery: "zombie-fallback",
            });
          } else if (deadFinalStep) {
            const lastStepText = (finalText ?? "").trim();
            if (await isAnnouncedActionStop(lastStepText)) {
              await runContinuation(
                modelMessages,
                await result.responseMessages,
              );
            }
          }
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
        async (turnObservation) => {
          // Anchor for out-of-context error reporting (see turnTrace).
          turnTrace.traceId = turnObservation.traceId;
          turnTrace.spanContext = turnObservation.otelSpan.spanContext();
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
              // Fold the turn outcome onto `chatbot-turn` so a failover is
              // filterable in Langfuse: `servedBy` (primary|fallback),
              // `recovery` (how the turn was rescued — absent when clean),
              // and the classified `errorReason` behind any recovery.
              const turnMetadata: Record<string, string> = {
                servedBy: servedByTurn,
              };
              // What the turn cost, by our own count, on the turn's own
              // observation — so a trace can be compared against the pipeline
              // that reports it. When the two disagree, the pipeline is wrong:
              // a 22x observation fan-out went unnoticed for two days because
              // there was nothing to disagree with. Metadata only, never
              // `costDetails`, which Langfuse would add to its children.
              const spend = readTurnUsage(usageKey);
              if (spend !== undefined) {
                turnMetadata.costUsd = spend.total.costUsd.toFixed(4);
                turnMetadata.modelSteps = spend.total.steps.toString();
                turnMetadata.costedSteps = spend.total.costedSteps.toString();
                turnMetadata.inputTokens = spend.total.inputTokens.toString();
                turnMetadata.cacheReadTokens =
                  spend.total.cacheReadTokens.toString();
                turnMetadata.outputTokens = spend.total.outputTokens.toString();
                turnMetadata.reasoningTokens =
                  spend.total.reasoningTokens.toString();
              }
              // This turn was served on the fallback because a PRIOR turn on
              // this conversation died mid-stream (cross-turn escalation).
              if (escalatedAfterMidstreamError) {
                turnMetadata.escalatedAfterMidstreamError = "true";
              }
              if (traceFinishReason !== undefined) {
                turnMetadata.finishReason = traceFinishReason;
              }
              if (recoveryKind !== undefined) {
                turnMetadata.recovery = recoveryKind;
              }
              if (recoveryErrorReason !== undefined) {
                turnMetadata.errorReason = recoveryErrorReason;
              }
              // A turn that answered NOTHING is invisible in the traces
              // otherwise: no usage, no finish reason, no provider, and
              // `output: null` on the root — indistinguishable from a user
              // Stop, which is the state 3 of 6 turns of session
              // 019ff9d5 ended in with no way to tell which. Both flags are
              // recorded so the two causes can be told apart before anything
              // is built on top of them (a stall watchdog needs to know the
              // stalls are real, and how long they actually run).
              if (visibleOutput.trim().length === 0) {
                turnMetadata.emptyTurn = "true";
              }
              if (abortController.signal.aborted) {
                turnMetadata.stopped = "true";
              }
              // A structured error reached the wire → the whole turn is
              // marked ERROR so it is filterable by level in Langfuse
              // (the raw payload is on the `turn-error` child event).
              updateActiveObservation(
                {
                  output: visibleOutput,
                  metadata: turnMetadata,
                  ...(turnTrace.errorStatus !== undefined
                    ? {
                        level: "ERROR" as const,
                        statusMessage: turnTrace.errorStatus,
                      }
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

  if (resumableStreamId === undefined) {
    // Stateless callers (`/internal/invoke`): direct passthrough, no turn
    // log, no recorder (they own their persistence). Heartbeat keeps long
    // tool-call gaps alive on the raw pipe.
    return wrapResponseWithSseHeartbeat(
      createUIMessageStreamResponse({
        stream:
          params.scrubSensitiveInputs === false
            ? rawStream
            : rawStream.pipeThrough(buildSensitiveInputScrubber()),
      }),
    );
  }

  // Incremental persistence rides a PRE-scrub tee: persisted parts carry
  // the real tool inputs (matching the final `onFinish` write), while the
  // wire — turn log included — only ever sees scrubbed frames.
  const [recorderBranch, wireBranch] = rawStream.tee();
  if (params.conversationId) {
    void recordTurnIncrementally({
      conversationId: params.conversationId,
      turnId: resumableStreamId,
      chunks: recorderBranch,
    });
  } else {
    void recorderBranch.cancel();
  }
  const outboundStream =
    params.scrubSensitiveInputs === false
      ? wireBranch
      : wireBranch.pipeThrough(buildSensitiveInputScrubber());

  // Turn-log transport. The pump is the ONLY wire consumer of the SDK
  // stream: it drives generation to completion (so `onFinish` —
  // persistence, slot release, `turn-ended` — always runs) and appends
  // every chunk to the per-turn Redis Stream. EVERY viewer, this
  // initiating POST included, reads the log back — one code path,
  // byte-identical frames live, on resume, and for collaborative fan-in,
  // all decoupled from any HTTP connection's lifetime. Producer liveness
  // pings ride the log itself (see turn-log.ts), so no per-connection
  // heartbeat wrapper here.
  //
  // The pump ends the log, and the end marker is what becomes the client's
  // `[DONE]` — so the turn's slow bookkeeping hangs off the pump rather than
  // off `onFinish`, which the log's closure waits for. It never rejects (it
  // catches internally and still writes an `error` end marker), so the
  // `.finally` runs on every outcome.
  void pumpChunksToTurnLog(resumableStreamId, outboundStream).finally(
    () => void settleTurn(),
  );
  return new Response(readTurnLogAsSse(resumableStreamId, "0-0"), {
    status: 200,
    headers: { ...UI_MESSAGE_STREAM_HEADERS, ...ANTI_BUFFERING_HEADERS },
  });
};

/**
 * Frequency of SSE keep-alive frames (5s — halved from 10s to survive
 * aggressive intermediate proxies during slow-model "silent thinking"
 * windows, while staying well under Bun's 30s `idleTimeout`). A first
 * ping is also emitted immediately on `start()` (see injectSseHeartbeat)
 * so the pre-first-token preamble — context loading + compaction —
 * never looks idle.
 */
const CHATBOT_HEARTBEAT_MS = 5_000;

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
 * Ride a `data-ping` on the stateless `/internal/invoke` passthrough every
 * `CHATBOT_HEARTBEAT_MS`, so a tool call that thinks for four minutes does not
 * read as a dead connection. The turn-log paths get their liveness from the
 * producer, inside the log itself (`turn-log.ts`), so every consumer inherits
 * it there.
 *
 * The pings come from `withHeartbeat`, which drives them from the READ side.
 * The shape this replaced enqueued from a `setInterval` inside a
 * TransformStream and emitted exactly one ping ever — see that module for what
 * it cost.
 */
const wrapResponseWithSseHeartbeat = (response: Response): Response => {
  if (!response.body) return response;
  const encoder = new TextEncoder();
  return new Response(
    withHeartbeat(response.body, CHATBOT_HEARTBEAT_MS, () =>
      encoder.encode(encodePingFrame()),
    ),
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

/**
 * Every turn resolves a model, and a model resolves against a snapshot this
 * process may have lost — see `ensureModelRegistryWarm`. A no-op on the common
 * path (one synchronous check), and the difference between a replica that
 * recovers and one that answers `UNKNOWN_MODEL_PROFILE` about healthy rows
 * until somebody restarts it.
 */
const registryWarmMiddleware = async (
  _c: unknown,
  next: () => Promise<void>,
): Promise<void> => {
  await ensureModelRegistryWarm();
  await next();
};

const chatbotRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatbotRoutes.use("*", authMiddleware);
chatbotRoutes.use("*", registryWarmMiddleware);
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
 * Per-request state (DynamicToolManager) is owned by
 * the agent's `prepareCall` hook — see `agents/shared/agent-builder.ts`.
 * Each request gets its own instance inside `prepareCall`'s closure,
 * garbage-collected when the stream ends. No cross-request leakage is
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

  const {
    conversationId,
    messages,
    mentionedUserIds,
    mentionsAssistant,
    reasoningLevel,
  } = parsed.data;

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
      // Keep the client's wire id (uuid via the frontend's `generateId`)
      // so the bubble the sender already rendered survives rehydration
      // with the same Vue key. A duplicate POST converges by upsert.
      id: isUuid(lastUser.id) ? lastUser.id : undefined,
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
      // Surface the new user message to other connected viewers right away
      // — covers human-to-human asides that never start an assistant turn,
      // and lets viewers paint the sender's bubble before the answer streams.
      await publishConversationEvent(conversationId, {
        type: "message-added",
        messageId: savedUserMessage.id,
        role: "user",
        authorId: user.id,
      });
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

  // Open the turn log BEFORE announcing the turn: the log exists from this
  // instant, so any viewer invited by `turn-started` attaches successfully
  // — there is no setup window where an attach finds nothing (the old
  // buffer registered seconds into the turn and early attachers 204'd).
  await openTurnLog(streamId);

  // Announce the turn to every connected viewer so non-senders fan-in to
  // the same turn log (live multi-user streaming) and their send button
  // gates while it runs. `byUserId` lets the sender's own client skip the
  // fan-in (it is already streaming via this POST).
  await publishConversationEvent(conversationId, {
    type: "turn-started",
    streamId,
    byUserId: user.id,
  });

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

  // C8 — which flagship model serves this turn: the conversation's pin (legacy
  // conversations, stamped when the prompt bar still had a model picker) → the
  // team's pick in settings → the code default. An unknown or
  // no-longer-selectable pin degrades rather than erroring.
  const {
    profileKey: flagshipKey,
    fellBack,
    storedReasoningLevel,
  } = await resolveTeamFlagship(team.id, conversation.modelProfileKey);
  if (fellBack && conversation.modelProfileKey) {
    console.warn(
      `[chatbot] conversation ${conversationId} pinned model "${conversation.modelProfileKey}" is not a selectable flagship — using default`,
    );
  }
  const profile = resolveChatModelForProfile(flagshipKey).profile;

  return runChatbotTurn({
    conversationId,
    history: speakerHistory,
    callOptions,
    resumableStreamId: streamId,
    logPrefix: "[chatbot]",
    agentSet: getChatbotAgentSet(flagshipKey),
    modelProfile: profile,
    // Thinking depth, outermost choice first: what this user picked in the
    // prompt bar for this turn, else the team's stored default for this model,
    // else the profile's own. `effectiveReasoningLevel` drops anything the
    // model does not support (and the profile default itself, so an untouched
    // turn stays byte-identical on the wire).
    reasoningLevel: effectiveReasoningLevel(
      profile,
      reasoningLevel ?? storedReasoningLevel,
    ),
  });
});

/**
 * How long after a turn claimed the slot its turn log is still assumed to
 * be on its way. The log is opened synchronously right after the claim, so
 * a MISSING log normally means Redis lost the key — but a request racing
 * the claim by milliseconds deserves the benefit of the doubt. The claim
 * uuid (v7) carries its own timestamp, so no extra state is needed.
 */
const STREAM_CLAIM_GRACE_MS = 15_000;

/** Redis Stream entry-id shape (`<ms>-<n>`); anything else falls to 0-0. */
const TURN_LOG_CURSOR_RE = /^\d+-\d+$/;

/**
 * GET /chatbot/:conversationId/stream — reconnection endpoint.
 *
 * Semantics:
 *   - 204 No Content   → no live turn (none claimed, or the producer died
 *                        and the slot was just cleared). The client falls
 *                        back to history.
 *   - 200 event-stream → the turn log replayed from the requested cursor
 *                        (`Last-Event-ID` header or `?cursor=`; absent →
 *                        `0-0`, a full structurally-complete replay).
 *                        Every data frame carries `id: <redis-entry-id>`
 *                        so the next reconnect resumes with zero overlap.
 *   - 404 / 403        → classic auth failures.
 *
 * Never blocks: the log always answers immediately (the old
 * `resumable-stream` handshake waited up to 1s on the producing process,
 * on the mount critical path). Orphan detection is a data check — a live
 * producer pings its log every 5s, so a stale tail means a dead process
 * and the slot is cleared on the spot.
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

  const status = await getTurnLogStatus(activeStreamId);
  if (!status.exists) {
    // The log is opened synchronously right after the claim, so a missing
    // log means Redis lost the key (flush/restart) — except for a request
    // racing the claim by milliseconds, which gets the benefit of the
    // doubt via the claim uuid's own timestamp.
    const claimedAt = uuidv7TimestampMs(activeStreamId);
    const isFreshClaim =
      claimedAt !== null && Date.now() - claimedAt < STREAM_CLAIM_GRACE_MS;
    if (!isFreshClaim) {
      await clearConversationActiveStream(conversationId, activeStreamId);
    }
    return new Response(null, { status: 204 });
  }
  if (status.ended) {
    // The log is closed but the slot survived it — the producer died between
    // its end marker and its cleanup, or its persistence threw. The turn is
    // over either way: everything it produced is in history, so serving the
    // log again would only replay a finished turn behind a slot that keeps
    // 409ing every new prompt. Same rule the maintenance sweep applies, but
    // on demand instead of on its cadence.
    await clearConversationActiveStream(conversationId, activeStreamId);
    return new Response(null, { status: 204 });
  }
  if (isTurnLogOrphan(status, Date.now())) {
    // Dead producer (deploy/crash mid-turn — or a stall long past even
    // the tool-aware deadline). SALVAGE, then clear: everything the turn
    // streamed becomes persisted history, so the client's fallback shows
    // the interrupted turn instead of nothing. Then clear the slot so the
    // conversation isn't stuck behind the 409 guard.
    await drainTurnLogToHistory({ conversationId, streamId: activeStreamId });
    await clearConversationActiveStream(conversationId, activeStreamId);
    return new Response(null, { status: 204 });
  }

  const rawCursor = c.req.header("Last-Event-ID") ?? c.req.query("cursor");
  const cursor =
    rawCursor && TURN_LOG_CURSOR_RE.test(rawCursor) ? rawCursor : "0-0";
  return new Response(readTurnLogAsSse(activeStreamId, cursor), {
    status: 200,
    headers: {
      ...UI_MESSAGE_STREAM_HEADERS,
      ...ANTI_BUFFERING_HEADERS,
    },
  });
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
 * GET /chatbot/:conversationId/events — long-lived per-viewer SSE channel
 * carrying the collaborative signals (turn-started / turn-ended,
 * message-added, presence, typing). Cross-replica fan-out via Redis
 * pub/sub. The initial snapshot lets a viewer joining mid-turn learn the
 * live streamId immediately (→ `resumeStream` fan-in) and see the roster.
 * Long-lived: returns only when the client disconnects (`stream.aborted`).
 */
chatbotRoutes.get("/:conversationId/events", async (c) => {
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

  for (const [key, value] of Object.entries(ANTI_BUFFERING_HEADERS)) {
    c.header(key, value);
  }
  return streamSSE(c, async (stream) => {
    // Bridge Redis pub/sub → an awaitable queue so every SSE write is
    // ordered + awaited (the Bun chunked-encoding footgun; see sse-utils).
    // The queue's shape is what keeps events from being dropped — see
    // `lib/sse-event-queue.ts`. Subscribing here, BEFORE the snapshot below,
    // is the other half of that: pub/sub has no replay.
    const events = createSseEventQueue(CHATBOT_HEARTBEAT_MS);
    const cleanup = await subscribeConversationEvents(conversationId, (p) =>
      events.push(p),
    );

    /* oxlint-disable no-await-in-loop -- sequential SSE writes are required */
    try {
      // Initial snapshot: any live turn + the current presence roster, so a
      // viewer joining mid-turn fans in and renders avatars without waiting
      // for the next event.
      // `turn-started` alone is the attach invite: the turn log exists from
      // the moment the slot is claimed (openTurnLog runs before the event is
      // published), so a viewer can always attach immediately — the separate
      // `turn-stream-ready` handshake is gone with the old buffer.
      //
      // Written AFTER the subscription above, and inside this `try`, for two
      // reasons. Subscribing second dropped every event published while the
      // snapshot was on the wire — pub/sub has no replay, and a lost
      // `turn-ended` leaves every viewer's send gate stuck on Stop until they
      // reload. And a client that disconnects mid-snapshot must still reach
      // the `finally` that unsubscribes. A `turn-started` delivered twice (in
      // the queue AND in the snapshot) is harmless: the client's attach is
      // single-flight and keyed by streamId.
      const activeStreamId = await getConversationActiveStream(conversationId);
      if (activeStreamId) {
        await stream.writeSSE({
          event: "message",
          data: JSON.stringify({
            type: "turn-started",
            streamId: activeStreamId,
            byUserId: "",
          }),
        });
      }
      await stream.writeSSE({
        event: "message",
        data: JSON.stringify({
          type: "presence",
          viewers: await listViewers(conversationId),
        }),
      });

      while (!stream.aborted) {
        for (let next = events.take(); next; next = events.take()) {
          await stream.writeSSE({ event: "message", data: next });
        }
        const outcome = await events.waitForEventOrHeartbeat();
        if (outcome === "heartbeat") {
          await stream.writeSSE({ event: "ping", data: "ping" });
        }
      }
    } finally {
      await cleanup();
    }
    /* oxlint-enable no-await-in-loop */
  });
});

const PresenceRequestSchema = z.object({ present: z.boolean().optional() });

/**
 * POST /chatbot/:conversationId/presence — viewer heartbeat. The client
 * re-posts every ~10s while the conversation is open (short Redis TTL
 * self-heals an unclean tab close) and posts `{ present: false }` on a
 * clean leave. Broadcasts the refreshed roster to the other viewers.
 */
chatbotRoutes.post("/:conversationId/presence", async (c) => {
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

  const body: unknown = await c.req.json().catch(() => ({}));
  const parsed = PresenceRequestSchema.safeParse(body);
  const present = parsed.success ? (parsed.data.present ?? true) : true;
  if (present) {
    await markPresent(conversationId, {
      userId: user.id,
      name: user.name,
      image: user.image ?? null,
    });
  } else {
    await removePresent(conversationId, user.id);
  }
  return c.json({ ok: true }, 200);
});

const TypingRequestSchema = z.object({ isTyping: z.boolean() });

/**
 * POST /chatbot/:conversationId/typing — broadcast a transient typing
 * on/off signal to the other viewers. No storage; the client auto-expires
 * the indicator after a few seconds.
 */
chatbotRoutes.post("/:conversationId/typing", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("conversationId");
  const body: unknown = await c.req.json();
  const parsed = TypingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ code: "VALIDATION_ERROR", message: "Invalid body" }, 400);
  }
  const conversation = await getConversation({
    id: conversationId,
    teamId: team.id,
    userId: user.id,
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }

  await publishTyping(
    conversationId,
    { userId: user.id, name: user.name },
    parsed.data.isTyping,
  );
  return c.json({ ok: true }, 200);
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
  // Served straight from this route, so it is its own root trace — named and
  // joined to the conversation's session (see `withNamedTrace`).
  const summary = await withNamedTrace(
    "catch-up-summary",
    {
      sessionId: conversationId,
      userId: user.id,
      tags: [`team:${team.id}`],
    },
    () =>
      summariseMissedMessages({
        missed,
        priorContext,
        participants: conversation.members,
        teamId: team.id,
      }),
  );

  return c.json({ summary }, 200);
});

// ==================== //
// INTERNAL ROUTES      //
// ==================== //

const chatbotInternalRoutes = new OpenAPIHono<HonoInternalAppType>();
chatbotInternalRoutes.use("*", internalMiddleware);
chatbotInternalRoutes.use("*", registryWarmMiddleware);

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

  // Second eval seam, and it exists because the first one was NOT enough:
  // `X-Model-Profile-Key` repoints the parent turn only, so a page candidate
  // run gated the model that DECIDES to build a page while the model that
  // WRITES it stayed on the `page-build` binding. Same rules as above — read
  // here so it cannot reach /stream, unknown keys refused rather than served.
  const pageBuildProfileKey = c.req.header("X-Page-Build-Profile-Key");
  if (pageBuildProfileKey !== undefined) {
    try {
      resolveChatModelForProfile(pageBuildProfileKey);
    } catch {
      return c.json(
        {
          code: "UNKNOWN_MODEL_PROFILE",
          message: `Unknown page-build profile key: "${pageBuildProfileKey}"`,
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
    pageBuildProfileKey,
  };

  // Internal `/invoke` callers (e.g. workflow nodes) do NOT go through
  // the turn-log path — they keep the HTTP connection open for
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
