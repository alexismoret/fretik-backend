import { access, teamOfResource } from "@fretik/shared/authz/http";
import { isProjectArchived } from "@fretik/shared/authz/placement";
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
import { notFound, throwHttpError } from "@fretik/shared/lib/errors";
import { redis } from "@fretik/shared/lib/redis";
import { ANTI_BUFFERING_HEADERS } from "@fretik/shared/lib/sse-headers";
import {
  ChatStreamRequestSchema,
  UiMessageSchema,
} from "@fretik/shared/schemas/ai";
import { ERROR_CODES } from "@fretik/shared/schemas/errors";
import {
  clearConversationActiveStream,
  getConversationActiveStream,
  setConversationActiveStream,
} from "@fretik/shared/services/ai/active-stream";
import {
  chatAudience,
  userWorksInTeam,
  worksInTeam,
} from "@fretik/shared/services/ai/audience";
import { loadCatchUpContext } from "@fretik/shared/services/ai/catch-up";
import {
  publishConversationEvent,
  subscribeConversationEvents,
} from "@fretik/shared/services/ai/conversation-events";
import {
  isTurnDiscarded,
  markTurnDiscarded,
} from "@fretik/shared/services/ai/discarded-turns";
import {
  getReadableConversation,
  requireConversation,
} from "@fretik/shared/services/ai/get";
import { markConversationRead } from "@fretik/shared/services/ai/members/mark-read";
import { applyMentions } from "@fretik/shared/services/ai/members/mention";
import {
  deleteStalePartialMessages,
  loadParticipantIds,
  saveMessage,
  saveMessages,
} from "@fretik/shared/services/ai/messages";
import {
  listViewers,
  markPresent,
  publishTyping,
  removePresent,
} from "@fretik/shared/services/ai/presence";
import {
  MAX_USER_MESSAGE_EDITS,
  rewindConversationToUserMessage,
} from "@fretik/shared/services/ai/rewind";
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
import { getTeamBotUserId } from "@fretik/shared/services/auth/bot-user";
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
import { shouldContinueTurn } from "../services/turn-continuation/decide";
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
  compactionCapForCeiling,
  contextCeilingReached,
  type ContextCeilingStep,
} from "../agents/shared/context-ceiling";
import {
  assembleContextFragments,
  ATTACHED_FILES_UNAVAILABLE,
  buildConversationAttachedFilesBlock,
  loadExternalApps,
} from "../agents/shared/fragments";
import type { StandingMode } from "../agents/shared/standing-memory";
import {
  isStandingMode,
  STANDING_MODE,
  standingBlockFor,
} from "../agents/shared/standing-memory";
import { subscribeAbort } from "../lib/abort-subscriber";
import { flushLangfuse, langfuseEnabled } from "../lib/langfuse";
import { deleteScore, recordScore } from "../lib/langfuse-scores";
import {
  effectiveReasoningLevel,
  getProfileForRole,
  reasoningParamForProfile,
  resolveChatModelForProfile,
} from "../lib/model-registry/resolve";
import { resolveTeamFlagship } from "../lib/model-registry/team-model";
import { extractOpenRouterReport } from "../lib/model-registry/transports/openrouter";
import type { ModelProfile, ReasoningLevel } from "../lib/model-registry/types";
import { buildSensitiveInputScrubber } from "../lib/scrub-stream";
import { createSseEventQueue } from "../lib/sse-event-queue";
import { withHeartbeat } from "../lib/sse-heartbeat";
import type { StreamErrorClassification } from "../lib/stream-errors";
import {
  classifyStreamError,
  describeStreamError,
  FAILOVER_SENTINEL,
  isRecoverableToolCallError,
  isTransparentlyRecoverable,
  NON_TERMINAL_STEP_ERROR,
  streamWithRetryThenFallback,
  TOOL_INPUT_RETRY_NOTICE,
  toStructuredError,
  USER_STOP_NOTICE,
  withSoftTimeout,
} from "../lib/stream-errors";
import { withNamedTrace } from "../lib/trace-tool";
import {
  formatTimings,
  markSince,
  recordTimingsOnTrace,
  tapFirstChunk,
  timeStage,
  type StageTimings,
} from "../lib/turn-timings";
import { forgetTurnUsage, readTurnUsage } from "../lib/turn-usage";
import { uuidv7TimestampMs } from "../lib/uuidv7-time";
import { dropNonTerminalErrorFrames } from "../lib/wire-errors";
import { chatbotRateLimitMiddleware } from "../middlewares/chatbot-rate-limit";
import { internalMiddleware } from "../middlewares/internal";
import { registryWarmMiddleware } from "../middlewares/registry-warm";
import { sendChatbotFinishedEmailIfEnabled } from "../services/chatbot-finished-email";
import {
  compactAheadOfNextTurn,
  loadAgentWindow,
  persistCheckpoint,
  type AgentWindowResult,
} from "../services/compaction/checkpoint-window";
import {
  compactConversation,
  type CompactionArtifact,
} from "../services/compaction/compact";
import { buildTurnBoundaryResume } from "../services/compaction/turn-boundary";
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
  isRecallMode,
  prefetchRecallGather,
  recallsIn,
  runUnifiedRecall,
  type RecallGathered,
  type RecallMode,
} from "../services/recall/recall";
import type { HonoInternalAppType } from "../types/hono";
import {
  buildTurnMessageMetadata,
  createStepClock,
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
      // Wire id preserved (uuid v7, minted once per turn by
      // `openAssistantMessage`) — DB ids stay identical to what the client
      // already rendered, and the upsert makes a recorder-then-onFinish double
      // write converge in place.
      id: isUuid(m.id) ? m.id : undefined,
      role: "assistant" as const,
      parts: m.parts,
      metadata: narrowMessageMetadata(m),
      turnId,
    })),
    tx,
  );
  // The recorder writes under the WIRE id. That id used to change whenever the
  // turn merged a second `toUIMessageStream` (failover, dead-step
  // continuation), leaving a pre-rename row the write above never overwrites —
  // a duplicate assistant message holding a prefix of these same parts.
  // `openAssistantMessage` removed the rename, so this now sweeps history
  // written before it and closes the window between the recorder's first flush
  // and a turn whose final ids differ for any other reason. Scoped to this turn
  // and to rows still marked partial.
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
    params.history.some((m) => m.role === "assistant") ||
    // "No assistant message in the window" and "first turn of the
    // conversation" were the same question only while the window WAS the whole
    // history. Anchored on a checkpoint, a 300-turn conversation can present a
    // window with no assistant message in it — and would be re-titled from
    // whatever was said last.
    params.agentWindow?.checkpoint != null
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
  /**
   * The window `history` came from, carrying the cut a checkpoint written
   * after this turn must use.
   *
   * Absent on the stateless `/invoke` path, which has no conversation to
   * anchor one to. Never re-derived here: the cut has to be the window the
   * turn actually READ, and asking the database for the end of the history
   * after the turn has answered would put that answer outside both the
   * summary and the next window.
   */
  agentWindow?: AgentWindowResult;
  /**
   * Conversation members at load time, frozen into any checkpoint this turn
   * writes. A summary is built from text already carrying `[Name]:` prefixes,
   * so the roster is part of what was summarised.
   */
  participantIds?: string[];
  callOptions: ChatbotCallOptions;
  /**
   * Whose context the assistant gathers by itself this turn — recall, the
   * memory index, standing memory, the persistent context: the sender's when
   * nobody else reads the chat, the team's agent's otherwise
   * (`chatAudience`). Absent → the sender's (`callOptions.userId`), as on the
   * stateless `/invoke` path. The tools still act for the sender.
   */
  contextUserId?: string;
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
   * A recall gather the caller started before the turn was set up, so the
   * retrieval arms ran underneath the route's serial prelude instead of after
   * it. See `prefetchRecallGather`. Absent on the internal `/invoke` path,
   * which has no prelude to hide behind.
   */
  prefetchedGather?: Promise<RecallGathered> | null;
  /**
   * When the HTTP request arrived, and what its serial prelude cost.
   *
   * TTFT is measured from the ROUTE, not from here: everything the prelude
   * does — persisting the message, binding files, two conversation events, the
   * read marker, the stream claim, the turn log, the history read, the model
   * resolution — happens before this function is called and is invisible to
   * `preTurnTotal`. A turn optimised against `preTurnTotal` alone can get
   * slower for the user while the number it reports improves.
   *
   * Absent on `/invoke`, which has no prelude — its `[ttft]` line omits the
   * label rather than reporting a zero it did not measure.
   */
  routeStartedAt?: number;
  preludeTimings?: StageTimings;
  /**
   * Serve this turn's recall under a specific selector — set by `/invoke` from
   * `X-Recall-Mode`, never reachable from `/stream`.
   *
   * The judge-vs-deterministic question is answered by scoring ANSWERS, which
   * means running the same cases through the real turn twice. `RECALL_MODE` is
   * a process default read at module load, so without this the two arms need a
   * service restart between them — and two runs taken minutes apart against a
   * live corpus are not a paired comparison.
   */
  recallMode?: RecallMode;
  /**
   * Serve `<standing_memory>` from a specific arm — set by `/invoke` from
   * `X-Standing-Mode`, never reachable from `/stream`.
   *
   * Same reason as `recallMode`: whether a standing block earns its place is
   * answered by scoring ANSWERS with it and without it, and `STANDING_MODE` is
   * a process default read at module load. Without this the arms are a restart
   * apart, which against a live corpus is not a paired comparison.
   */
  standingMode?: StandingMode;
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
): Promise<ChatbotCallOptions> => {
  // Captured in a const so the truthiness narrowing survives into the
  // `propagateAttributes` callback closure below (a const can't change, so
  // TS keeps the `string` narrowing; a property access would widen back).
  const activeMemoryUserId = params.contextUserId ?? params.callOptions.userId;
  const activeMemoryInputs =
    activeMemoryUserId && recallsIn(params.callOptions)
      ? buildActiveMemoryInputs(params.history, filenames)
      : null;
  // The three scope-based fragments (context manifest, team objects, skills)
  // are assembled by the shared `assembleContextFragments` — same soft
  // timeouts and soft-fail semantics as the historical inline version (C4:
  // HANG backstops, not latency caps). The two history-dependent fragments
  // (attached files, active-memory recall) stay here and run in the same
  // parallel batch.
  // Whether `<standing_memory>` is served this turn. Per request, so the
  // rollback can be exercised without a restart — same contract as
  // `recallMode`.
  const standingMode = params.standingMode ?? STANDING_MODE;

  // Every stage below is timed into one record and logged as a single
  // key=value line (see `lib/turn-timings.ts`). These run in parallel, so the
  // labels do NOT sum to `preTurnTotal` — the slowest one is what TTFT pays.
  const timings: StageTimings = {};
  const startedAt = Date.now();

  const [
    attachedFilesBlock,
    activeMemoryRecall,
    fragments,
    toolPolicies,
    externalApps,
  ] = await Promise.all([
    // Conversation-scoped, NOT last-message-scoped: a file part that the
    // active profile can't ingest natively is dropped from the history by
    // `prepareModelMessages` (and native ones past the recency cap with
    // it), so this block is the ONLY thing that keeps an earlier turn's
    // attachment knowable. Scoping it to the last user message made every
    // such file vanish on turn 2 — the agent then reports it has no files
    // while they sit readable in `attachments/`. Same builder the workflow
    // handler uses.
    timeStage(
      timings,
      "attachedFiles",
      withSoftTimeout(
        buildConversationAttachedFilesBlock(params.conversationId),
        4000,
        ATTACHED_FILES_UNAVAILABLE,
        "attached-files",
      ),
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
            userId: params.callOptions.userId ?? activeMemoryUserId,
            tags: [`team:${params.callOptions.teamId}`],
          },
          () =>
            timeStage(
              timings,
              "recall",
              withSoftTimeout(
                runUnifiedRecall({
                  userMessage: activeMemoryInputs.userMessage,
                  attachedFiles: activeMemoryInputs.attachedFiles,
                  recentTail: activeMemoryInputs.recentTail,
                  teamId: params.callOptions.teamId,
                  organizationId: params.callOptions.organizationId,
                  userId: activeMemoryUserId,
                  ...(params.callOptions.projectId === undefined
                    ? {}
                    : { projectId: params.callOptions.projectId }),
                  conversationId: params.conversationId,
                  agentType: "chatbot",
                  // Started at the top of the route when there was one — the
                  // arms have been running through the whole prelude and this
                  // collects what is left of them.
                  ...(params.prefetchedGather
                    ? { gatherPromise: params.prefetchedGather }
                    : {}),
                  // Eval seam. `bypassCache` rides with it: two arms asking
                  // the same question seconds apart must each pay their own
                  // pass, or the second one scores the first one's block.
                  ...(params.recallMode
                    ? { modeOverride: params.recallMode, bypassCache: true }
                    : {}),
                }),
                // ABOVE the recall's own 15s judge budget
                // (RECALL_TIMEOUT_MS) + RAG headroom — only fires on a true
                // RAG hang, never on a normal (multi-second) judge
                // generation.
                18000,
                null,
                "active-memory",
              ),
            ),
        )
      : Promise.resolve(null),
    timeStage(
      timings,
      "contextFragments",
      assembleContextFragments(
        {
          organizationId: params.callOptions.organizationId,
          teamId: params.callOptions.teamId,
          userId: activeMemoryUserId,
          projectId: params.callOptions.projectId,
          outsideTeam: params.callOptions.outsideTeam,
          logPrefix: params.logPrefix,
        },
        { mode: standingMode },
      ),
    ),
    timeStage(
      timings,
      "toolPolicies",
      getTeamToolPolicies(params.callOptions.teamId),
    ),
    // External apps joined this batch rather than running ahead of it. It
    // used to be awaited BEFORE `buildTurnCallOptions`, in series, because
    // it also minted the sandbox JWT — that write is now lazy (see
    // `loadExternalApps`), leaving a plain `listConnections` with no reason
    // to block anything.
    timeStage(timings, "externalApps", loadChatbotExternalApps(params)),
  ]);

  timings["preTurnTotal"] = Date.now() - startedAt;
  console.info(
    `${params.logPrefix} contextManifestChars=${(fragments.chatbotContextManifest ?? "").length.toString()} activeMemory=${activeMemoryRecall ? "hit" : "miss"} teamCollectionsChars=${(fragments.teamCollectionsBlock ?? "").length.toString()} enabledSkillsChars=${(fragments.enabledSkillsBlock ?? "").length.toString()}`,
  );
  console.info(`${params.logPrefix} [pre-turn] ${formatTimings(timings)}`);
  recordTimingsOnTrace("pre-turn", timings);

  return {
    ...params.callOptions,
    attachedFilesBlock:
      attachedFilesBlock.length > 0 ? attachedFilesBlock : undefined,
    chatbotContextManifest: fragments.chatbotContextManifest,
    memoryIndexBlock: fragments.memoryIndexBlock,
    standingMemoryBlock: standingBlockFor(
      fragments.standingMemoryBlock,
      activeMemoryRecall?.block,
    ),
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
  // sandbox access. That claim used to be false: the external-app setup
  // minted the sandbox JWT eagerly and acquired the sandbox to write it,
  // in series, ahead of everything. The JWT now rides
  // `prepareSandboxForCode` too, so the sentence holds again.

  // Assemble the per-turn system-prompt fragments + external apps into
  // the final call options handed to the agent. See buildTurnCallOptions.
  // The turn's setup, end to end: the parallel batch plus the two Redis round
  // trips after it. `preTurnTotal` covers only the batch and closes before the
  // rest, so this stretch of the path had no number of its own.
  const setupTimings: StageTimings = {};
  const setupStartedAt = Date.now();

  const callOptionsWithFiles = await timeStage(
    setupTimings,
    "preTurn",
    buildTurnCallOptions(params, filenames),
  );

  // User-initiated Stop plumbing (Phase 12). See setupAbortChannel.
  const { abortController, releaseAbortSubscriber } = await timeStage(
    setupTimings,
    "abortChannel",
    setupAbortChannel(params),
  );

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
    (await timeStage(
      setupTimings,
      "midstreamMarker",
      consumeMidstreamErrorMarker(params.conversationId),
    ));
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

  markSince(setupTimings, "setupTotal", setupStartedAt);
  console.info(`${params.logPrefix} [setup] ${formatTimings(setupTimings)}`);

  /**
   * The turn's headline latency number, emitted when the first frame a reader
   * could see reaches the wire.
   *
   * Once per turn, whichever stream produces that frame — the primary, the
   * fallback model, or the dead-step continuation all pass this same callback
   * to `tapFirstChunk`, and the flag here is what makes "first" mean the turn
   * rather than the stream. `firstByte` is measured from ROUTE ENTRY on
   * `/stream`; `/invoke` has no prelude and reports from its own start, with
   * the `prelude` label absent rather than zeroed.
   */
  let ttftEmitted = false;
  const emitTtft = (): void => {
    if (ttftEmitted) return;
    ttftEmitted = true;
    const startedAt = params.routeStartedAt ?? setupStartedAt;
    const ttft: StageTimings = {
      ...(params.preludeTimings
        ? { prelude: params.preludeTimings["preludeTotal"] ?? 0 }
        : {}),
      preTurn: setupTimings["preTurn"] ?? 0,
      setup: setupTimings["setupTotal"] ?? 0,
    };
    markSince(ttft, "firstByte", startedAt);
    console.info(`${params.logPrefix} [ttft] ${formatTimings(ttft)}`);
    recordTimingsOnTrace("ttft", ttft);
  };

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
  // Whether a terminal (structured) frame is already on the wire. The two
  // sites that can put one there — `recordStreamError` for a fatal error,
  // the post-merge branch for a transient one that turned out to be fatal
  // after all — must not both fire for the same failure. A flag, not string
  // equality on the frame: `resume` is read from live turn state and could
  // differ between the two reads, which would slip a duplicate past
  // `emittedWireErrors`.
  let terminalFrameOnWire = false;
  // The host that served the last step that COMPLETED. Kept beside the flags
  // rather than in them because nothing in the turn's logic reads it — it
  // exists so a `turn-error` can name a provider at all. It is deliberately
  // not called "the host that failed": a pre-response failure (a 429, an empty
  // pool) never reaches a serving host, and a mid-stream failure ends its step
  // without `providerMetadata`, so in both cases this is the PREVIOUS step's
  // host. Recorded under a key that says so.
  let lastCompletedStepProvider: string | undefined;
  const onTurnStep: GenerateTextOnStepEndCallback<ChatbotTools> = (step) => {
    const calledTool = step.toolCalls.length > 0 || step.toolResults.length > 0;
    if (calledTool) turnFlags.toolExecuted = true;
    if (step.text.length > 0) turnFlags.visibleText = true;
    turnFlags.lastStepCalledTool = calledTool;
    turnFlags.lastStepVisibleChars = step.text.trim().length;
    lastCompletedStepProvider =
      extractOpenRouterReport(step.providerMetadata).servingProvider ??
      lastCompletedStepProvider;
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
  /**
   * The wire frame for a turn we are calling dead, plus the two side effects
   * that go with that verdict: the trace's ERROR status, and the marker that
   * escalates the NEXT turn to the fallback model (skipped for pinned
   * callers — no conversationId, or a caller-supplied agentSet: eval gate /
   * workers). Shared by `recordStreamError` (fatal, decided inline) and the
   * post-merge branch (transient, decided once the stream has rejected), so
   * both spellings of "the turn died" have exactly one implementation.
   *
   * `resume` tells the client to CONTINUE the turn (a tool already ran —
   * replaying would repeat the side effect) rather than regenerate.
   */
  const terminalErrorFrame = (
    classification: StreamErrorClassification,
  ): string => {
    // The side effects belong to the FIRST verdict only — both callers can
    // reach this for the same failure (fatal: `onError` decides, then the
    // post-merge branch confirms), and `errorStatus` is the once-flag for
    // both, so the escalation marker is not re-armed on the second pass.
    if (turnTrace.errorStatus === undefined) {
      turnTrace.errorStatus = `${classification.kind}/${classification.reason}`;
      if (
        params.conversationId !== undefined &&
        params.agentSet === undefined
      ) {
        markMidstreamError(params.conversationId, classification.reason);
      }
    }
    return JSON.stringify(
      toStructuredError(classification, {
        resume: turnFlags.toolExecuted,
        ...(turnTrace.traceId !== undefined
          ? { traceId: turnTrace.traceId }
          : {}),
      }),
    );
  };
  // Map a stream error onto the wire. Three outcomes, and only the last one
  // reaches the user: the transparent-failover sentinel (the recovery seam
  // re-streams the fallback), the non-terminal marker (the agent loop may
  // still recover — both are stripped before the wire by
  // `dropNonTerminalErrorFrames`), or a structured fatal frame the client
  // renders with a one-click retry.
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
      return emit(USER_STOP_NOTICE);
    }
    // A bad tool input / unknown tool is NOT a turn death: the SDK already fed
    // it back to the model as a recoverable tool-error part (multi-step). Label
    // the UI part and let the turn continue — never a structured fatal frame.
    if (isRecoverableToolCallError(err)) {
      console.info(
        `${params.logPrefix} recoverable tool-call error (${err instanceof Error ? err.name : "unknown"}) — model self-corrects`,
      );
      return emit(TOOL_INPUT_RETRY_NOTICE);
    }
    const classification = classifyStreamError(err);
    // Log the full error OBJECT (stack + cause chain) — a name/message
    // string is not enough to root-cause a mid-stream validation error.
    console.error(
      `${params.logPrefix} mid-stream ${classification.kind}/${classification.reason}:`,
      err,
    );
    const transparent = isTransparentFailure(err);
    // A transient failure is NOT a verdict on the turn. The AI SDK's agent
    // loop turns a mid-stream provider error into a failed STEP and keeps
    // looping — measured on a NextBit 502 (prod 2026-09-08): errored at
    // step 2, answered at step 8 three minutes later, `result.text`
    // resolving normally. `onError` runs while that is still open, so it
    // declares nothing terminal here; the post-merge branch, which knows
    // whether the stream actually died, writes the terminal frame.
    const terminal = !transparent && classification.kind === "fatal";
    // Land the raw error on the Langfuse trace: ERROR only when the turn is
    // being called dead, WARNING when it is absorbed (transparent failover,
    // or a step the loop can retry). Without this, an errored turn has zero
    // ERROR observation and every debug session restarts from the dev
    // console. Point-in-time event, parented explicitly (see turnTrace).
    if (turnTrace.spanContext !== undefined) {
      startObservation(
        "turn-error",
        {
          level: terminal ? "ERROR" : "WARNING",
          statusMessage: `${classification.kind}/${classification.reason}`,
          input: describeStreamError(err),
          metadata: {
            reason: classification.reason,
            kind: classification.kind,
            transparentFailover: String(transparent),
            terminal: String(terminal),
            // Which host the turn was last KNOWN to be on. Before this, a
            // `turn-error` carried no provider at all, so "is this host
            // failing more than that one" could not be asked of the data —
            // only of an impression. Absent on a failure that happened before
            // any step completed, which is itself the answer to "was a host
            // even reached".
            lastCompletedStepProvider: lastCompletedStepProvider ?? "none",
          },
        },
        { asType: "event", parentSpanContext: turnTrace.spanContext },
      );
    }
    if (transparent) return emit(FAILOVER_SENTINEL);
    if (!terminal) return emit(NON_TERMINAL_STEP_ERROR);
    terminalFrameOnWire = true;
    return emit(terminalErrorFrame(classification));
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

  /**
   * The absolute ceiling on a CHAT's between-turn compaction — the same
   * per-turn context ceiling every other agent uses.
   *
   * It sat at three times that figure until the persisted checkpoint landed,
   * and the reason was never the chat's tolerance for a big context: it was
   * that nothing STORED a compaction summary. `compactConversation` worked in
   * memory and the next turn reloaded the same rows, so a threshold at the
   * ceiling put a fresh summariser call (10-40 s measured on 100 K+ inputs) in
   * front of every message of every conversation past 100 K — measured, 22 %
   * of them. 300 000 was the number that still caught the pathology actually
   * observed (a conversation starting EVERY step at 327 681 tokens, 2.69 M
   * tokens for one user message) without paying that on ordinary traffic.
   *
   * `loadAgentWindow` now starts a conversation at its last checkpoint and
   * `persistCheckpoint` writes the next one after the turn commits, so the
   * summariser runs once per cut instead of once per message. The constant
   * that held the line is no longer needed, and the chat compacts where
   * everything else does.
   *
   * Where everything else does is NOT the ceiling itself, though: the ceiling
   * counts the whole request and this counts the history, so they are set one
   * prefix apart. `compactionCapForCeiling` explains what happened the day
   * they were equal.
   */
  const CHATBOT_COMPACTION_CAP = compactionCapForCeiling(
    agentSet.contextCeiling,
    agentSet.agentId,
  );

  /**
   * What this turn's compaction produced, if it fired — persisted as a
   * checkpoint once the turn's own messages have committed.
   *
   * Declared out here because the two halves live in different closures:
   * `turnBody` runs the compaction, `onFinish` knows whether the turn was
   * rewound away and whether its messages actually landed. Writing it from
   * `turnBody` would checkpoint turns that were discarded or failed to
   * persist.
   */
  let compactionArtifact: CompactionArtifact | null = null;

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
      // A turn the user rewound past writes NOTHING — not the messages (they
      // would land under the message that replaced their prompt, since the
      // rewind deleted the rows this write would otherwise have upserted in
      // place) and not the `chat.turn` journal entry (an answer nobody kept
      // is not an episode worth distilling). The teardown below still runs:
      // the slot release is a compare-and-swap the new turn already won, and
      // `turn-ended` for a dead streamId is a no-op on every viewer.
      const discarded = await isTurnDiscarded(params.resumableStreamId);
      if (discarded) {
        console.info(
          `${params.logPrefix} turn ${params.resumableStreamId} was rewound away — skipping persistence`,
        );
      }
      // Persist the turn's messages AND journal its `chat.turn` boundary in
      // ONE transaction — the outbox guarantee (both commit or neither). The
      // event feeds memory recall + future workflow triggers; dedup-keyed on
      // the final message id so a re-fired `onFinish` never double-journals.
      // Payload carries previews + tool names so the distiller can build an
      // episode without reloading the turn.
      try {
        if (!discarded) {
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
        }
      } catch (err) {
        // Rethrown at the very end — the teardown below runs first.
        persistError = err;
        console.error(
          `${params.logPrefix} turn persistence failed — tearing the turn down anyway:`,
          err instanceof Error ? err.message : err,
        );
      }
      // The resume point, written only once the turn's own rows have
      // committed: the checkpoint cuts BELOW them, so a checkpoint that
      // outlived a rolled-back persistence would summarise up to a point the
      // conversation never reached.
      if (
        !discarded &&
        persistError === undefined &&
        params.conversationId &&
        params.agentWindow
      ) {
        const artifact: CompactionArtifact | null = compactionArtifact;
        if (artifact !== null) {
          void persistCheckpoint({
            conversationId: params.conversationId,
            window: params.agentWindow,
            summary: artifact.summary,
            activatedTools: artifact.activatedTools,
            participantIds: params.participantIds ?? [],
            kind: "llm",
            tokensBefore: artifact.tokensBefore,
            tokensAfter: artifact.tokensAfter,
            keptTailCount: artifact.keptTailCount,
            teamId: params.callOptions.teamId,
            ...(params.resumableStreamId
              ? { turnId: params.resumableStreamId }
              : {}),
          });
        } else {
          // Nothing compacted in front of THIS turn, which is the ordinary
          // case — so this is where we find out whether the NEXT one would
          // have to. Doing it now costs the user nothing; doing it then costs
          // them the summariser.
          void compactAheadOfNextTurn({
            conversationId: params.conversationId,
            profile: modelProfile,
            capTokens: CHATBOT_COMPACTION_CAP,
            participantIds: params.participantIds ?? [],
            teamId: params.callOptions.teamId,
            logPrefix: params.logPrefix,
            ...(params.resumableStreamId
              ? { turnId: params.resumableStreamId }
              : {}),
          });
        }
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

      /**
       * Open the turn's ONE assistant message, before anything is written into
       * it. Idempotent; every producer calls it, nobody has to know whether it
       * ran.
       *
       * Without it the turn opened its message by accident, at whatever moment
       * the first merged stream happened to emit `start` — and a compaction
       * card is written well before that. The client reader keys on the id it is
       * accumulating: a write while that id does not match the last message in
       * the list PUSHES a new bubble instead of replacing it, and a `start`
       * chunk RENAMES the accumulator. So the card was pushed under the reader's
       * own provisional id, the model's `start` renamed the accumulator to a
       * fresh uuid, and the next write pushed a second time. Measured
       * 2026-09-18: one `<article data-role=assistant>` holding only the card,
       * then a second holding the card and the answer.
       *
       * Naming the message up front fixes the ordering, and `sendStart: false`
       * on every merged stream keeps it fixed — a merged stream that emitted its
       * own `start` would rename the accumulator again and push again, which is
       * also what split a failover's answer across two bubbles.
       *
       * LAZY, not at the top of `execute`: a turn that dies before producing
       * anything writes an error frame and no message, and an assistant bubble
       * opened for it would be an empty one — on screen, and in the row the turn
       * recorder would flush for it.
       *
       * The id follows the SDK's own rule (`getResponseUIMessageId`): continue
       * the last message when the history ends on an assistant one, otherwise
       * mint a uuid v7, which `saveMessages` then persists verbatim.
       */
      const lastHistoryMessage = params.history.at(-1);
      const responseMessageId =
        lastHistoryMessage?.role === "assistant"
          ? lastHistoryMessage.id
          : randomUUIDv7();
      let messageOpened = false;
      const openAssistantMessage = (): void => {
        if (messageOpened) return;
        messageOpened = true;
        writer.write({ type: "start", messageId: responseMessageId });
      };

      /**
       * Open the message on a merged stream's FIRST chunk, not when it is
       * merged.
       *
       * `writer.merge` is called the moment the provider call is open, and the
       * first chunk arrives whole seconds later — a message opened at merge
       * time is an empty assistant bubble for all of that wait, sitting next to
       * the "preparing…" placeholder. Enqueuing after the open, rather than
       * tapping after it like `tapFirstChunk` does for TTFT, is what keeps the
       * `start` in front of the chunk that needed it.
       */
      const openedOnFirstChunk = <C>(
        stream: ReadableStream<C>,
      ): ReadableStream<C> =>
        stream.pipeThrough(
          new TransformStream<C, C>({
            transform(chunk, controller) {
              openAssistantMessage();
              controller.enqueue(chunk);
            },
          }),
        );

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
            openAssistantMessage();
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
          // Its own clock: the fallback times its own calls (see createStepClock).
          const fallbackStepClock = createStepClock();
          writer.merge(
            openedOnFirstChunk(
              dropChunksAfterAbort(
                tapFirstChunk(
                  toUIMessageStream<ChatbotTools>({
                    stream: fallbackResult.stream,
                    // The turn's message is already open and already named —
                    // see `openAssistantMessage`. A second `start` would rename
                    // the client's accumulator and split the answer in two.
                    sendStart: false,
                    onError: recordStreamError,
                    messageMetadata: ({ part }) => {
                      if (part.type !== "finish")
                        return fallbackStepClock(part);
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
                  emitTtft,
                ),
                abortController.signal,
              ),
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
            openAssistantMessage();
            const finalId = randomUUIDv7();
            // Same id across the three chunks — see the note on the notice above.
            writer.write({ type: "text-start", id: finalId });
            writer.write({
              type: "text-delta",
              id: finalId,
              delta:
                "Both models stopped without producing an answer. Please retry. For large attachments, try opening the file directly in `python` (e.g. `pdfplumber.open(...)`, `pd.read_csv(...)`).",
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
      /**
       * Stream one continuation of THIS turn into the same writer, and fold
       * its output into the turn's trace.
       *
       * Two callers with different reasons and the same wire: the dead-step
       * recovery below, which re-sends the whole partial turn plus a nudge,
       * and the context boundary, which re-sends a summary of it instead.
       */
      const streamContinuation = async (
        messages: ModelMessage[],
        agent: AgentSet<ChatbotCallOptions, ChatbotTools>["primary"],
        kind: string,
        servedBy: "primary" | "fallback",
      ): Promise<{
        finishReason: string;
        steps: readonly ContextCeilingStep[];
        responseMessages: ModelMessage[];
      }> => {
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
        const contStepClock = createStepClock();
        writer.merge(
          openedOnFirstChunk(
            dropChunksAfterAbort(
              tapFirstChunk(
                toUIMessageStream<ChatbotTools>({
                  stream: contResult.stream,
                  // Same message as the steps before it — a continuation IS the
                  // turn continuing. See `openAssistantMessage`.
                  sendStart: false,
                  onError: recordStreamError,
                  messageMetadata: ({ part }) => {
                    if (part.type !== "finish") return contStepClock(part);
                    return buildTurnMessageMetadata(
                      part,
                      servedBy,
                      modelProfile.key,
                      getActiveTraceId(),
                      readTurnUsage(usageKey),
                    );
                  },
                }),
                emitTtft,
              ),
              abortController.signal,
            ),
          ),
        );
        const [contFinish, contText, steps, responseMessages] =
          await Promise.all([
            contResult.finishReason,
            contResult.text,
            contResult.steps,
            contResult.responseMessages,
          ]);
        visibleOutput = [visibleOutput, contText ?? ""]
          .filter((s) => s.length > 0)
          .join("\n");
        // Same rule as `runFallbackModel`: the continuation owns the trace's
        // finish reason only when it produced the visible answer.
        if ((contText ?? "").trim().length > 0) traceFinishReason = contFinish;
        return { finishReason: contFinish, steps, responseMessages };
      };

      /**
       * A backstop, not the bound.
       *
       * The bound is the reduction invariant: `buildTurnBoundaryResume`
       * refuses to return a resume that is not at most `BOUNDARY_MAX_RATIO`
       * of what it folded, so each crossing at least halves the carried
       * context and the loop is geometrically convergent on its own. This
       * number exists only so that a bug in that arithmetic costs a bounded
       * number of turns rather than an unbounded one — it should never be the
       * reason a turn ends, and the log line says so when it is.
       *
       * It replaced a hard limit of 2 that came from nowhere: two crossings
       * was neither measured nor derived, and it ended turns that were
       * converging perfectly well.
       */
      const BOUNDARY_BACKSTOP = 8;

      /**
       * The context boundary, mid-answer.
       *
       * The ceiling stop-condition ends the loop while the model still wanted
       * to work, which on its own would hand the user a truncated answer. So
       * the turn continues — from a summary of everything so far instead of
       * everything so far. From the provider's side this is a new user turn:
       * previous reasoning is "Allowed" to be absent, nothing signed spans the
       * boundary, and thinking is live again on the resume. Nothing is written
       * to the wire about it; the user sees one answer, produced in two calls.
       */
      const runBoundaryContinuation = async (
        baseMessages: ModelMessage[],
        partialMessages: ModelMessage[],
      ): Promise<void> => {
        let carried: ModelMessage[] = [...baseMessages, ...partialMessages];
        for (let boundary = 1; boundary <= BOUNDARY_BACKSTOP; boundary += 1) {
          const resume = await buildTurnBoundaryResume({
            messages: carried,
            teamId: params.callOptions.teamId,
            logPrefix: params.logPrefix,
          });
          // Nothing on the ladder reduced — not the summariser, not the
          // mechanical pass, not truncation. Keep the partial answer rather
          // than restart the model on a context that did not get smaller.
          if (resume === null) return;
          const outcome = await streamContinuation(
            [resume.message],
            agentSet.primary,
            "context-boundary",
            "primary",
          );
          if (
            !contextCeilingReached(outcome.steps, agentSet.contextCeiling) ||
            outcome.finishReason !== "tool-calls"
          ) {
            return;
          }
          carried = [resume.message, ...outcome.responseMessages];
        }
        console.warn(
          `${params.logPrefix} turn hit the boundary backstop (${BOUNDARY_BACKSTOP.toString()} crossings) — the reduction invariant should have converged before this`,
        );
      };

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
          const { finishReason: contFinish } = await streamContinuation(
            messages,
            agent,
            kind,
            servedBy,
          );
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
        // The last two stretches before a token can be produced, and the two
        // the pre-turn instrumentation could not see: `buildTurnCallOptions`
        // has already returned by here, so `preTurnTotal` stops short of both.
        // Compaction is usually a token count and a fast path, but summarises
        // with an LLM above the threshold; `prepareModelMessages` can reach S3
        // for natively-ingested attachments. Neither had a number.
        const bodyTimings: StageTimings = {};
        const historyForModel = await timeStage(
          bodyTimings,
          "compaction",
          compactConversation(params.history, {
            // Threshold follows the SERVING model's context window — the
            // profile resolved above (header override or `chat` binding).
            profile: modelProfile,
            // …capped in absolute terms, which is what actually binds on a
            // wide-window model: derived from a 1M window the threshold is
            // ~960K, so a conversation measured starting EVERY step at 327 681
            // tokens (2026-09-17, 2.69M tokens for one user message and two
            // mid-turn cache breaks) was never once above it.
            maxThresholdTokens: CHATBOT_COMPACTION_CAP,
            // Names the observation `compaction` instead of letting it land as
            // an anonymous `chat <model>` beside the turn's own generation —
            // the only way the summariser's cost is separable from the agent's.
            ...(params.conversationId
              ? { traceSessionId: params.conversationId }
              : {}),
            // Summariser honours the team's workhorse pick (C8b).
            teamId: params.callOptions.teamId,
            // Captured, not written here: `onFinish` is the only place that
            // knows whether this turn was rewound away mid-stream and whether
            // its messages actually committed.
            onCompacted: (artifact) => {
              compactionArtifact = artifact;
            },
            onProgress: (event) => {
              // The shared `id` makes consecutive writes UPDATE the
              // single existing data part on the client (started → done
              // / failed) instead of stacking three separate cards.
              // The frontend renders this part as a UChatTool with a
              // loader while phase==='running' and transitions to a
              // success / failure state on the final write.
              //
              // The card is the first thing a turn ever puts on the wire, and
              // for a long time it was also what opened the turn's message by
              // accident — see `openAssistantMessage` for the two bubbles that
              // produced.
              openAssistantMessage();
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
          }),
        );

        // `streamText` returns as soon as the stream is open, so this measures
        // preparing the messages (native-input policy, S3 for attachments the
        // profile ingests natively) plus opening the provider call — the last
        // thing standing between the user and a first token, not the
        // generation itself.
        const { result, servedBy, retried, modelMessages } = await timeStage(
          bodyTimings,
          "streamSetup",
          streamChatbotWithFallback({
            history: historyForModel,
            callOptions: callOptionsWithFiles,
            agentSet,
            modelProfile,
            abortSignal: abortController.signal,
            onStepFinish: onTurnStep,
            reasoningOverride,
          }),
        );
        console.info(
          `${params.logPrefix} [turn-body] ${formatTimings(bodyTimings)}`,
        );
        recordTimingsOnTrace("turn-body", bodyTimings);
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
        // every part of the inner stream. On `finish` the returned blob
        // lands in the assistant message's `metadata`: `langfuseTraceId`
        // (so the feedback control can score the right Langfuse trace) plus
        // `finishReason` / `usage` (read by the eval harness over SSE).
        // Before it, only the step clock speaks — one `stepDurations` entry
        // per settled tool call, for the transcript's step timers; nothing
        // is ever emitted on `start`, which would overwrite a prior turn
        // with `undefined`. Full per-turn observability — tool calls, RAG
        // hits, latency, cost — lives in Langfuse.
        const stepClock = createStepClock();
        writer.merge(
          openedOnFirstChunk(
            dropChunksAfterAbort(
              tapFirstChunk(
                toUIMessageStream<ChatbotTools>({
                  stream: result.stream,
                  // The id is minted and written by `openAssistantMessage`; the
                  // model's own `start` would only rename it, and renaming is
                  // what the client turns into a second bubble.
                  sendStart: false,
                  // A provider `error` part (e.g. empty pool) surfaces through
                  // the INNER stream's onError, not the outer one — route it to
                  // the same mapper so both surfaces agree on the wire frame.
                  onError: recordStreamError,
                  messageMetadata: ({ part }) => {
                    if (part.type !== "finish") return stepClock(part);
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
                emitTtft,
              ),
              abortController.signal,
            ),
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
            // failover was already spent. THIS is where a turn is known to
            // be dead: the stream rejected instead of resolving. A fatal
            // error already put its frame on the wire from `onError`
            // (`emittedWireErrors` makes `terminalErrorFrame` idempotent
            // for it); a transient one was deliberately left non-terminal
            // there, so its frame is written here — the only place with
            // the evidence to justify it. Partials persist via `onFinish`.
            recoveryKind = "structured-error";
            if (!terminalFrameOnWire) {
              terminalFrameOnWire = true;
              const frame = terminalErrorFrame(classification);
              emittedWireErrors.add(frame);
              writer.write({ type: "error", errorText: frame });
            }
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
          // Context boundary, checked FIRST: the ceiling ends a loop that was
          // still working, so `finishReason` is `tool-calls` — which is also
          // what an ordinary step-cap stop looks like, hence the explicit
          // ceiling test rather than a reason match. The continuation produces
          // the rest of the answer, so the zombie / dead-step tests below must
          // not also fire on the same turn.
          const ceilingCut =
            finishReason === "tool-calls" &&
            contextCeilingReached(
              await result.steps,
              // The SAME number the stop condition used, published by the set
              // rather than re-derived: on a narrow model the resolved ceiling
              // sits below the absolute one, and asking the absolute question
              // here would leave a real ceiling stop unrecognised — no
              // boundary, no continuation, half an answer.
              agentSet.contextCeiling,
            );
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
          if (ceilingCut) {
            await runBoundaryContinuation(
              modelMessages,
              await result.responseMessages,
            );
          } else if (primaryZombied) {
            console.error(
              `${params.logPrefix} primary zombied (finish=${finishReason}) — chaining to fallback model`,
            );
            await runFallbackModel(historyForModel, {
              notice: true,
              recovery: "zombie-fallback",
            });
          } else if (deadFinalStep) {
            const lastStepText = (finalText ?? "").trim();
            if (
              await shouldContinueTurn({
                finalText: lastStepText,
                teamId: params.callOptions.teamId,
                organizationId: params.callOptions.organizationId,
                ...(params.conversationId !== undefined
                  ? { conversationId: params.conversationId }
                  : {}),
                ...(params.resumableStreamId !== undefined
                  ? { turnKey: params.resumableStreamId }
                  : {}),
              })
            ) {
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
        stream: (params.scrubSensitiveInputs === false
          ? rawStream
          : rawStream.pipeThrough(buildSensitiveInputScrubber())
        ).pipeThrough(dropNonTerminalErrorFrames()),
      }),
    );
  }

  // Incremental persistence rides a PRE-scrub tee: persisted parts carry
  // the real tool inputs (matching the final `onFinish` write), while the
  // wire — turn log included — only ever sees scrubbed frames. The recorder
  // needs no error filtering of its own: it already reads with
  // `terminateOnError: false` (services/ai/turn-recorder).
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
  // The non-terminal error drop is NOT conditional on `scrubSensitiveInputs`
  // — it is not about secrets. It runs on every wire, so the turn log (which
  // every viewer and every resume replays) never carries a frame that would
  // make the client SDK stop reading a turn that is still alive.
  const outboundStream = (
    params.scrubSensitiveInputs === false
      ? wireBranch
      : wireBranch.pipeThrough(buildSensitiveInputScrubber())
  ).pipeThrough(dropNonTerminalErrorFrames());

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

const chatbotRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatbotRoutes.use("*", authMiddleware);
chatbotRoutes.use("*", registryWarmMiddleware);
// Rate limit ONLY the user-facing /stream route, and only AFTER the
// auth middleware has populated `c.get("team")`. The limit is scoped
// per teamId — see middlewares/chatbot-rate-limit.ts for rationale.
chatbotRoutes.use("/stream", chatbotRateLimitMiddleware);

/**
 * Kill whatever turn is running for a conversation AND make sure its output
 * never reaches history.
 *
 * The first two steps are `POST /:id/stop`'s: publish on the abort channel,
 * clear the slot. The discard marker is the third, and it is what makes this
 * safe to call in front of a rewind — the producer keeps unwinding for a
 * moment after the abort, and its `onFinish` would otherwise re-insert the
 * very rows the rewind is about to delete, landing a stale answer under the
 * message that replaced its prompt. Marked BEFORE the abort so the turn cannot
 * finish in the gap.
 */
const cancelTurnForRewind = async (
  conversationId: string,
): Promise<string | null> => {
  const activeStreamId = await getConversationActiveStream(conversationId);
  if (!activeStreamId) return null;
  await markTurnDiscarded(activeStreamId);
  await redis.publish(getAbortChannel(activeStreamId), "1");
  await clearConversationActiveStream(conversationId, activeStreamId);
  return activeStreamId;
};

/**
 * Merge the server-owned rewind bookkeeping into a re-sent message's metadata.
 *
 * `editCount` comes from the row the rewind locked and is stamped on BOTH
 * paths, retries included, where it is simply unchanged. It has to be: the
 * metadata underneath it is whatever the browser sent back, so a client that
 * returned `editCount: 0` on each retry would hand itself three fresh edits
 * every time. `editedAt` moves only when the wording did.
 */
const withRewindMetadata = (
  base: unknown,
  editCount: number,
  edited: boolean,
): Record<string, unknown> => {
  // The client's metadata is `unknown` by the SDK's typing and arrives from a
  // browser, so anything that is not a plain object is simply replaced.
  const existing =
    typeof base === "object" && base !== null && !Array.isArray(base)
      ? { ...base }
      : {};
  return {
    ...existing,
    editCount,
    ...(edited ? { editedAt: new Date().toISOString() } : {}),
  };
};

/** HTTP status for a refused rewind. Never 409 — see the call site. */
const REWIND_REFUSAL_STATUS = {
  "not-found": 404,
  "not-a-user-message": 403,
  "not-the-author": 403,
  "limit-reached": 422,
} as const;

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
chatbotRoutes.post(
  "/stream",
  access.handler(
    "A turn is written by someone who takes part in its conversation: `use`, decided by the engine on the body's conversationId (requireConversation).",
  ),
  async (c) => {
    // TTFT starts HERE. Everything below this line and above `runChatbotTurn` is
    // serial I/O the user waits through, and until now none of it was measured:
    // `[pre-turn]` opens at `buildTurnCallOptions`, several round trips later.
    const routeStartedAt = Date.now();
    const preludeTimings: StageTimings = {};

    const user = c.get("user");
    const organization = c.get("organization");

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
      editedMessageId,
      retriedMessageId,
    } = parsed.data;

    // The turn runs in the chat's own place, whichever team the caller has
    // open: its team, and its project when it has one. Taking part is for the
    // people who work there (`authz/rules.ts`: the project's, else the
    // team's), and its context is the one the assistant answers in.
    const { resource, conversation } = await timeStage(
      preludeTimings,
      "getConversation",
      requireConversation({
        principal: c.get("principal"),
        conversationId,
        level: "use",
      }),
    );
    const teamId = conversation.teamId;
    const projectId = conversation.projectId ?? undefined;
    // An archived project reads as it was and takes nothing new, a message
    // included, until it is restored. Not 409, like everywhere else the
    // project refuses: on this route the client transport reads a 409 as "a
    // turn is already streaming, attach to it", which would swallow it.
    if (projectId !== undefined && (await isProjectArchived(projectId))) {
      return c.json(
        {
          code: ERROR_CODES.PROJECT_ARCHIVED,
          message:
            "This project is archived. Restore it to write in its chats.",
        },
        423,
      );
    }
    // Someone who takes part in a project of another team: the team's own
    // context stays out of their turns.
    const outsideTeam = !worksInTeam(c.get("principal"), teamId);
    // What the assistant gathers by itself (recall, memory, the persistent
    // context) is read for everyone the answer reaches: the sender's own when
    // nobody else reads the chat, the team's (in a project, the project's)
    // otherwise — never one person's private memory or files where others
    // will read what it writes.
    const audience = chatAudience(resource.node, user.id);
    const contextUserId = audience.others
      ? await timeStage(preludeTimings, "contextUser", getTeamBotUserId(teamId))
      : user.id;

    // Persist the new user message (last one in the incoming array),
    // attributed to its human author. This happens BEFORE the activation
    // gate so a human-to-human aside is still stored and seen by the others.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");

    // Retrieval starts HERE, ahead of everything the turn still has to set up.
    //
    // The gather depends on the message text, its attachments and the session's
    // scope — all three are already in hand — and on nothing produced below.
    // Everything between this line and `runChatbotTurn` is serial I/O: saving the
    // message, binding its files, two conversation events, the read marker,
    // mentions, the stream claim, the turn log, the history since the last
    // checkpoint, the model resolution. Ten round trips the three retrieval arms can run
    // underneath instead of after.
    //
    // Fire-and-collect, never awaited here: `prefetchRecallGather` swallows its
    // own failures, and `runUnifiedRecall` reads the promise back through
    // `gatherPromise`. A turn that never reaches recall (the activation gate
    // below, a 409 on the stream claim) simply drops it.
    //
    // One deliberate difference from the text the turn later sees: in a
    // conversation with two or more participants `buildSpeakerContext` prefixes
    // user messages with `[Name]: `, and that happens far below this line. The
    // arms therefore retrieve against the message WITHOUT the speaker label,
    // which is the more faithful query anyway — a colleague's name is noise to
    // an embedding of "what is the Nordwind delivery cadence". Solo
    // conversations, the overwhelming majority, are byte-identical either way.
    const prefetchedGather =
      lastUser && organization && recallsIn({ projectId, outsideTeam })
        ? prefetchRecallGather({
            userMessage: uiMessageText(lastUser),
            attachedFiles: extractLastUserFileFilenames([lastUser]).map(
              (filename) => ({
                filename,
                mimeType: inferMimeTypeFromFilename(filename),
              }),
            ),
            // Judge-only, and assembled after the await in `runUnifiedRecall`
            // from the history this has not waited for.
            recentTail: "",
            teamId,
            organizationId: organization.id,
            userId: contextUserId,
            ...(projectId === undefined ? {} : { projectId }),
            conversationId,
            agentType: "chatbot",
          })
        : null;

    // An EDIT re-sends a message already in the thread with NEW wording; a RETRY
    // re-sends it verbatim because the user wants another answer to the same
    // question. Either way the conversation rewinds to that message before
    // anything else happens: the turn below then answers against a history that
    // no longer holds what the previous attempt produced
    // (`loadConversationForAgent` reads the same rows).
    //
    // The order here is the whole trick. Cancel first — a running turn is
    // precisely what would write into the gap the rewind opens — then delete
    // everything after the message, then let the ordinary `saveMessage` below
    // upsert it onto the same row (id, `seq` and `created_at` survive, so the
    // bubble stays where it is and keeps its original time).
    //
    // What the two modes do NOT share is the budget. Only an edit is counted
    // against `MAX_USER_MESSAGE_EDITS` and only an edit can be refused for having
    // spent it: the cap exists so the question cannot be rewritten indefinitely,
    // and a retry rewrites nothing.
    const rewoundMessageId = editedMessageId ?? retriedMessageId;
    const countsAsEdit = editedMessageId !== undefined;
    let editCount: number | null = null;
    if (rewoundMessageId) {
      if (!lastUser || lastUser.id !== rewoundMessageId) {
        return c.json(
          {
            code: "INVALID_REWIND",
            message: `${countsAsEdit ? "editedMessageId" : "retriedMessageId"} must name the last user message of this request.`,
          },
          400,
        );
      }
      const cancelledTurnId = await timeStage(
        preludeTimings,
        "cancelForRewind",
        cancelTurnForRewind(conversationId),
      );
      const rewound = await timeStage(
        preludeTimings,
        "rewind",
        rewindConversationToUserMessage({
          conversationId,
          messageId: rewoundMessageId,
          userId: user.id,
          countsAsEdit,
        }),
      );
      if (!rewound.ok) {
        // Deliberately never 409: the client transport reads that status as "a
        // turn is already streaming, attach to it instead", which would swallow
        // the refusal and leave the user looking at a truncated thread.
        return c.json(
          {
            code:
              rewound.reason === "limit-reached"
                ? "EDIT_LIMIT_REACHED"
                : countsAsEdit
                  ? "EDIT_REFUSED"
                  : "RETRY_REFUSED",
            message: `Cannot ${countsAsEdit ? "edit" : "retry"} this message (${rewound.reason}).`,
            editCount: rewound.editCount,
            maxEdits: MAX_USER_MESSAGE_EDITS,
          },
          REWIND_REFUSAL_STATUS[rewound.reason],
        );
      }
      editCount = rewound.nextEditCount;
      console.info(
        `[chatbot] conversation ${conversationId} rewound to ${rewoundMessageId} — ` +
          (countsAsEdit
            ? `edit ${editCount}/${MAX_USER_MESSAGE_EDITS}`
            : `retry (edit ${editCount}/${MAX_USER_MESSAGE_EDITS} untouched)`) +
          `, ${rewound.deletedMessages} message(s) dropped` +
          (cancelledTurnId ? `, turn ${cancelledTurnId} discarded` : ""),
      );
    }

    if (lastUser) {
      const savedUserMessage = await timeStage(
        preludeTimings,
        "saveMessage",
        saveMessage({
          conversationId,
          role: "user",
          parts: lastUser.parts,
          metadata:
            editCount === null
              ? lastUser.metadata
              : withRewindMetadata(lastUser.metadata, editCount, countsAsEdit),
          authorId: user.id,
          // Keep the client's wire id (uuid via the frontend's `generateId`)
          // so the bubble the sender already rendered survives rehydration
          // with the same Vue key. A duplicate POST converges by upsert.
          id: isUuid(lastUser.id) ? lastUser.id : undefined,
        }),
      );
      // Bind every `ai_chat_files` row that was created in the draft
      // (messageId = NULL) to the message we just persisted. The orphan
      // reaper keys off `messageId IS NULL` to reap abandoned drafts —
      // flipping this field here removes those rows from its scan.
      if (savedUserMessage) {
        const attachedFilenames = extractLastUserFileFilenames([lastUser]);
        await timeStage(
          preludeTimings,
          "linkFiles",
          linkChatFilesToMessage(
            conversationId,
            attachedFilenames,
            savedUserMessage.id,
          ),
        );
        // Surface the new user message to other connected viewers right away
        // — covers human-to-human asides that never start an assistant turn,
        // and lets viewers paint the sender's bubble before the answer streams.
        //
        // A rewind — edit or retry — announces itself differently: a viewer that
        // merely appended the message would keep the exchange the rewind just
        // deleted sitting underneath it, so `message-edited` means "reload,
        // don't merge". `editCount` is non-null on exactly those two paths.
        await timeStage(
          preludeTimings,
          "publishAdded",
          publishConversationEvent(
            conversationId,
            editCount === null
              ? {
                  type: "message-added",
                  messageId: savedUserMessage.id,
                  role: "user",
                  authorId: user.id,
                }
              : {
                  type: "message-edited",
                  messageId: savedUserMessage.id,
                  authorId: user.id,
                },
          ),
        );
      }
    }

    // The sender has, by definition, just read the conversation — clear their
    // own unread / action-required state.
    await timeStage(
      preludeTimings,
      "markRead",
      markConversationRead({ conversationId, userId: user.id }),
    );

    // Pull @mentioned teammates into the conversation and notify them.
    if (mentionedUserIds && mentionedUserIds.length > 0) {
      const mentioned = await timeStage(
        preludeTimings,
        "mentions",
        applyMentions({
          principal: c.get("principal"),
          resource,
          mentionedUserIds,
        }),
      );
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
    const claimed = await timeStage(
      preludeTimings,
      "claimStream",
      setConversationActiveStream(conversationId, streamId),
    );
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
    await timeStage(preludeTimings, "openTurnLog", openTurnLog(streamId));

    // Announce the turn to every connected viewer so non-senders fan-in to
    // the same turn log (live multi-user streaming) and their send button
    // gates while it runs. `byUserId` lets the sender's own client skip the
    // fan-in (it is already streaming via this POST).
    await timeStage(
      preludeTimings,
      "publishStarted",
      publishConversationEvent(conversationId, {
        type: "turn-started",
        streamId,
        byUserId: user.id,
      }),
    );

    // Everything after the last checkpoint. Tokens bound the window — the
    // compaction cap folds the older portion into the next checkpoint — and
    // the row limit is only a guard; see `AGENT_WINDOW_ROW_LIMIT`.
    const window = await timeStage(
      preludeTimings,
      "loadHistory",
      loadAgentWindow(conversationId),
    );
    const history = window.messages;

    // Attribute speakers when the conversation is collaborative (≥2 members).
    // Solo conversations are left untouched — see buildSpeakerContext.
    const { history: speakerHistory, participantsBlock } = buildSpeakerContext({
      history,
      participants: conversation.members,
    });

    const callOptions: ChatbotCallOptions = {
      organizationId: organization.id,
      teamId,
      userId: user.id,
      userName: user.name,
      conversationId,
      projectId,
      outsideTeam,
      timeZone: c.req.header("X-Client-Timezone"),
      participantsBlock,
      openToReaders: audience.readers,
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
    } = await timeStage(
      preludeTimings,
      "resolveFlagship",
      resolveTeamFlagship(teamId, conversation.modelProfileKey),
    );
    if (fellBack && conversation.modelProfileKey) {
      console.warn(
        `[chatbot] conversation ${conversationId} pinned model "${conversation.modelProfileKey}" is not a selectable flagship — using default`,
      );
    }
    const profile = resolveChatModelForProfile(flagshipKey).profile;

    markSince(preludeTimings, "preludeTotal", routeStartedAt);
    console.info(`[chatbot] [prelude] ${formatTimings(preludeTimings)}`);

    return runChatbotTurn({
      conversationId,
      history: speakerHistory,
      agentWindow: window,
      participantIds: conversation.members.map((m) => m.userId),
      callOptions,
      contextUserId,
      prefetchedGather,
      routeStartedAt,
      preludeTimings,
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
  },
);

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
chatbotRoutes.get(
  "/:conversationId/stream",
  access.resource("conversation", "view", "conversationId"),
  async (c) => {
    // Whoever reads the conversation watches its live turn.
    const conversationId = c.req.param("conversationId");
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
  },
);

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
chatbotRoutes.post(
  "/:conversationId/stop",
  access.resource("conversation", "use", "conversationId"),
  async (c) => {
    // Any participant stops the turn; a reader only watches it.
    const conversationId = c.req.param("conversationId");
    const activeStreamId = await getConversationActiveStream(conversationId);
    if (!activeStreamId) {
      return c.json({ stopped: false, reason: "no-active-stream" }, 200);
    }

    await redis.publish(getAbortChannel(activeStreamId), "1");
    await clearConversationActiveStream(conversationId, activeStreamId);

    return c.json({ stopped: true }, 200);
  },
);

/**
 * GET /chatbot/:conversationId/events — long-lived per-viewer SSE channel
 * carrying the collaborative signals (turn-started / turn-ended,
 * message-added, presence, typing). Cross-replica fan-out via Redis
 * pub/sub. The initial snapshot lets a viewer joining mid-turn learn the
 * live streamId immediately (→ `resumeStream` fan-in) and see the roster.
 * Long-lived: returns only when the client disconnects (`stream.aborted`).
 */
chatbotRoutes.get(
  "/:conversationId/events",
  access.resource("conversation", "view", "conversationId"),
  async (c) => {
    // Readers follow along too: turns, new messages, presence, typing.
    const conversationId = c.req.param("conversationId");
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
        const activeStreamId =
          await getConversationActiveStream(conversationId);
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
  },
);

const PresenceRequestSchema = z.object({ present: z.boolean().optional() });

/**
 * POST /chatbot/:conversationId/presence — viewer heartbeat. The client
 * re-posts every ~10s while the conversation is open (short Redis TTL
 * self-heals an unclean tab close) and posts `{ present: false }` on a
 * clean leave. Broadcasts the refreshed roster to the other viewers.
 */
chatbotRoutes.post(
  "/:conversationId/presence",
  access.resource("conversation", "view", "conversationId"),
  async (c) => {
    // A reader shows among who is viewing, like a participant.
    const user = c.get("user");
    const conversationId = c.req.param("conversationId");
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
  },
);

const TypingRequestSchema = z.object({ isTyping: z.boolean() });

/**
 * POST /chatbot/:conversationId/typing — broadcast a transient typing
 * on/off signal to the other viewers. No storage; the client auto-expires
 * the indicator after a few seconds.
 */
chatbotRoutes.post(
  "/:conversationId/typing",
  access.resource("conversation", "use", "conversationId"),
  async (c) => {
    const user = c.get("user");
    const conversationId = c.req.param("conversationId");
    const body: unknown = await c.req.json();
    const parsed = TypingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ code: "VALIDATION_ERROR", message: "Invalid body" }, 400);
    }

    await publishTyping(
      conversationId,
      { userId: user.id, name: user.name },
      parsed.data.isTyping,
    );
    return c.json({ ok: true }, 200);
  },
);

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

chatbotRoutes.post(
  "/feedback",
  access.handler(
    "Feedback on a message of a conversation the caller takes part in: `use`, decided by the engine on the body's conversationId (requireConversation).",
  ),
  async (c) => {
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

    // Only those who take part score its answers: the thumb chosen is shown
    // to everyone on the message, so a reader does not set it.
    await requireConversation({
      principal: c.get("principal"),
      conversationId,
      level: "use",
    });

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
  },
);

/**
 * POST /chatbot/:conversationId/summary — "summarise what I missed".
 *
 * Builds a short, speaker-aware catch-up of every message the caller hasn't
 * read yet (since their `lastReadAt` / `joinedAt`). Membership-gated. Does
 * NOT mark the conversation read — the client decides when to clear unread.
 */
chatbotRoutes.post(
  "/:conversationId/summary",
  access.resource("conversation", "view", "conversationId"),
  async (c) => {
    const user = c.get("user");
    const conversationId = c.req.param("conversationId");
    // Summarised in the conversation's own team, whichever one is open.
    const resource = c.get("resource");
    const teamId = teamOfResource(resource);
    const conversation = await getReadableConversation({
      resource,
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
        tags: [`team:${teamId}`],
      },
      () =>
        summariseMissedMessages({
          missed,
          priorContext,
          participants: conversation.members,
          teamId,
        }),
    );

    return c.json({ summary }, 200);
  },
);

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
chatbotInternalRoutes.post(
  "/invoke",
  access.internal(
    "The API and the workflow engine invoke the agent for a team and, when there is one, a person they name.",
  ),
  async (c) => {
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

    // Third eval seam, same rules again: which SELECTOR turns retrieval into the
    // memory block. `RECALL_MODE` is a process default read at module load, so
    // comparing the judge against the deterministic path otherwise means
    // restarting the service between arms — and two runs taken minutes apart
    // against a live corpus are not a paired comparison. Read here so it can
    // never reach /stream; unknown values refused rather than silently served.
    const recallModeHeader = c.req.header("X-Recall-Mode");
    if (recallModeHeader !== undefined && !isRecallMode(recallModeHeader)) {
      return c.json(
        {
          code: "UNKNOWN_RECALL_MODE",
          message: `Unknown recall mode: "${recallModeHeader}" (expected judge | verbatim | adaptive)`,
        },
        400,
      );
    }
    const recallMode: RecallMode | undefined = recallModeHeader;

    // Same contract, same reason, for the standing block: `digest` (the
    // generated summary) vs `episodes` (the deterministic index) vs `none` (the
    // control arm, which is what makes the other two measurable at all).
    const standingModeHeader = c.req.header("X-Standing-Mode");
    if (
      standingModeHeader !== undefined &&
      !isStandingMode(standingModeHeader)
    ) {
      return c.json(
        {
          code: "UNKNOWN_STANDING_MODE",
          message: `Unknown standing mode: "${standingModeHeader}" (expected episodes | none)`,
        },
        400,
      );
    }
    const standingMode: StandingMode | undefined = standingModeHeader;

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

    /**
     * The window, KEPT — not read for its `messages` and thrown away.
     *
     * Dropping it was a real defect and an expensive one. `onFinish` writes the
     * checkpoint only when `agentWindow` is present, so this route read
     * checkpoints and never wrote one: every turn on a long conversation
     * reloaded the whole history and ran a fresh summariser. Measured 2026-09-18
     * on a 340 000-token conversation over four two-turn probes — 8 turns, 8 full
     * summariser runs, `compaction=29 634…60 776 ms` on every one of them,
     * including the turns that should have opened on a checkpoint written three
     * seconds earlier.
     *
     * It matters most exactly where it is least visible: `/invoke` is the
     * server-to-server route, so the turns paying that were workflow nodes and
     * evals, where nobody is watching a spinner and the cost shows up only on
     * the bill.
     */
    // The context headers are trusted — this route sits behind the internal
    // key — but a conversation named in the body is still checked against them:
    // a caller that mixes up one id must fail, not replay another team's history
    // under this team's identity.
    // A conversation also brings its place: a project chat's turns work in
    // the project, here as on the user-facing route.
    let projectId: string | undefined;
    if (conversationId) {
      const conversation = await db.query.aiConversations.findFirst({
        columns: { id: true, projectId: true },
        where: { id: conversationId, teamId: context.teamId },
      });
      if (!conversation) {
        return throwHttpError(404, notFound("Conversation not found"));
      }
      projectId = conversation.projectId ?? undefined;
    }
    const outsideTeam =
      context.userId !== undefined &&
      !(await userWorksInTeam({
        organizationId: context.organizationId,
        teamId: context.teamId,
        userId: context.userId,
      }));

    const window = conversationId
      ? await loadAgentWindow(conversationId)
      : null;
    const history: UIMessage[] = window ? window.messages : messages;
    // Read rather than defaulted to `[]`: an empty cast is one the reader's
    // `participants_changed` guard can never reject, because it only engages at
    // two or more. See `loadParticipantIds`.
    const participantIds = conversationId
      ? await loadParticipantIds(conversationId)
      : [];

    const callOptions: ChatbotCallOptions = {
      organizationId: context.organizationId,
      teamId: context.teamId,
      userId: context.userId,
      userName: context.userName,
      conversationId,
      projectId,
      outsideTeam,
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
      ...(window ? { agentWindow: window } : {}),
      participantIds,
      callOptions,
      agentSet,
      modelProfile,
      recallMode,
      standingMode,
      // Server-to-server channel: deliver real tool inputs (see
      // RunChatbotTurnParams.scrubSensitiveInputs).
      scrubSensitiveInputs: false,
      logPrefix: "[chatbot.invoke]",
    });
  },
);

export { chatbotInternalRoutes, chatbotRoutes };
