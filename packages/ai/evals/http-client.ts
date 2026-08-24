/**
 * HTTP bridge to a running `@fretik/ai` service.
 *
 * Not a test file — part of the live-LLM eval harness (see
 * `run.ts`). Reads env vars `AI_SERVICE_URL`, `INTERNAL_KEY`,
 * `EVAL_TEAM_ID`, `EVAL_ORGANIZATION_ID` and optionally
 * `EVAL_USER_ID` / `EVAL_USER_NAME` / `EVAL_TIMEZONE`.
 *
 * Posts a single stateless `user` message to
 * `POST /internal/agents/chatbot/invoke`, consumes the returned
 * UIMessage SSE stream, and returns an `InvokeResult`.
 *
 * The parser is deliberately UIMessage-shape-aware (not framework-
 * aware): it matches the same chunk types the frontend's
 * `@ai-sdk/vue` client consumes, so behaviour stays aligned with
 * production. Frame parsing is defensive: malformed JSON is skipped,
 * missing fields yield `undefined`, and an aborted stream still
 * produces a partial result rather than throwing.
 */

import { FAILOVER_SENTINEL } from "../src/lib/stream-errors";
import type { InvokeResult, ToolCallTrace } from "./types";

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord =>
  typeof v === "object" && v !== null;

const readString = (rec: UnknownRecord, key: string): string | undefined => {
  const v = rec[key];
  return typeof v === "string" ? v : undefined;
};

const readNumber = (rec: UnknownRecord, key: string): number | undefined => {
  const v = rec[key];
  return typeof v === "number" ? v : undefined;
};

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing eval env var: ${name}`);
  return v;
};

export interface InvokeOptions {
  /**
   * Registry profile key to pin the turn to, sent as the
   * `X-Model-Profile-Key` header (C3 gate candidate runs). Omitted →
   * the service's default `chat` binding.
   */
  modelProfileKey?: string;
  /**
   * Registry profile the PAGE BUILDER runs on, sent as
   * `X-Page-Build-Profile-Key`. A separate knob because the two are separate
   * models: `modelProfileKey` pins the turn that DECIDES to build a page, this
   * pins the one that writes it. Pinning only the first is what made every page
   * measurement before 2026-08-18 a measurement of the code default.
   */
  pageBuildProfileKey?: string;
}

const buildHeaders = (opts?: InvokeOptions): Record<string, string> => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "X-Internal-Key": requireEnv("INTERNAL_KEY"),
    "X-Context-Team-Id": requireEnv("EVAL_TEAM_ID"),
    "X-Context-Organization-Id": requireEnv("EVAL_ORGANIZATION_ID"),
  };
  if (process.env.EVAL_USER_ID)
    headers["X-Context-User-Id"] = process.env.EVAL_USER_ID;
  if (process.env.EVAL_USER_NAME)
    headers["X-Context-User-Name"] = process.env.EVAL_USER_NAME;
  if (process.env.EVAL_TIMEZONE)
    headers["X-Context-Timezone"] = process.env.EVAL_TIMEZONE;
  // C3 gate: pin the turn to a candidate registry profile. The /invoke
  // handler 400s on unknown keys, which surfaces here as an `error`
  // result instead of silently scoring the default model.
  if (opts?.modelProfileKey)
    headers["X-Model-Profile-Key"] = opts.modelProfileKey;
  if (opts?.pageBuildProfileKey)
    headers["X-Page-Build-Profile-Key"] = opts.pageBuildProfileKey;
  return headers;
};

const buildBody = (prompt: string, conversationId?: string): string =>
  JSON.stringify({
    // Always forward `messages`. When `conversationId` is set the
    // chatbot handler IGNORES `messages` and loads history from DB
    // instead, but we still send both so a stale harness vs. handler
    // combo behaves sensibly. See handlers/chatbot.ts `/invoke` for
    // the precedence rule.
    messages: [
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
        metadata: {},
      },
    ],
    ...(conversationId ? { conversationId } : {}),
  });

/**
 * UIMessage stream frames over SSE as `data: {...}\n\n`. Parse one
 * multi-line frame chunk into 0..N JSON payloads (dropping malformed
 * or non-data lines silently).
 */
const parseFrame = (frame: string): UnknownRecord[] => {
  const out: UnknownRecord[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      // Silently skip malformed JSON — the stream is best-effort.
    }
  }
  return out;
};

interface PendingToolCall {
  name: string;
  input: unknown;
  startedAtMs: number;
}

interface StreamState {
  textParts: string[];
  toolInputs: Map<string, PendingToolCall>;
  toolCalls: ToolCallTrace[];
  finishReason: string | undefined;
  usage: InvokeResult["usage"];
  traceId: string | undefined;
  stepsUsed: number;
  servedBy: string | undefined;
  modelProfileKey: string | undefined;
  error: string | undefined;
}

/**
 * Exported for `tests/unit/evals/stream-accounting.test.ts`. What this reducer
 * counts becomes `tool-call-count`, `redundant-call-count` and
 * `tool-budget-overage`, so a drift here does not fail — it reports a plausible
 * wrong number. It already did once, by a factor of ten.
 */
export const createStreamState = (): StreamState => ({
  textParts: [],
  toolInputs: new Map<string, PendingToolCall>(),
  toolCalls: [],
  finishReason: undefined,
  usage: undefined,
  traceId: undefined,
  stepsUsed: 0,
  servedBy: undefined,
  modelProfileKey: undefined,
  error: undefined,
});

export const absorbChunk = (chunk: UnknownRecord, state: StreamState): void => {
  const type = readString(chunk, "type");
  if (!type) return;
  switch (type) {
    case "text-delta": {
      const delta = readString(chunk, "delta");
      if (delta !== undefined) state.textParts.push(delta);
      return;
    }
    case "start-step": {
      // One frame per agent-loop step (model generation). Counting
      // them gives `stepsUsed` without any server-side change.
      state.stepsUsed++;
      return;
    }
    case "error": {
      // Surfaced stream error (e.g. an empty provider pool kills the
      // turn after `start`). Without this, an errored turn looks like
      // a ZOMBIE (no text, no error) and pollutes that metric — the
      // 2026-06-12 M3 gate failure mode. Keep the FIRST error: it is
      // the root cause; later frames are downstream noise.
      const text = readString(chunk, "errorText");
      // C4: a transparent failover emits a sentinel error frame before
      // re-streaming on the fallback. It is NOT a turn error — the
      // fallback's answer follows — so ignore it (else a recovered turn
      // would score as failed and `servedBy:"fallback"` already flags it).
      if (text === FAILOVER_SENTINEL) return;
      // A structured error frame carries the turn's `traceId` — the only
      // chance to capture it on an errored turn (no finish metadata ever
      // arrives), so the failing trace stays reachable from TaskOutput.
      if (text !== undefined) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (isRecord(parsed)) {
            const errTraceId = readString(parsed, "traceId");
            if (errTraceId !== undefined) state.traceId ??= errTraceId;
          }
        } catch {
          // Not a JSON structured error — keep the raw text as-is.
        }
      }
      state.error ??= text ?? "stream error frame without errorText";
      return;
    }
    case "tool-input-available": {
      // This is the "tool dispatched" moment — record the timestamp
      // so we can compute per-tool latency when the matching
      // `tool-output-available` arrives.
      const id = readString(chunk, "toolCallId");
      const name = readString(chunk, "toolName");
      if (id && name) {
        state.toolInputs.set(id, {
          name,
          input: chunk["input"],
          startedAtMs: Date.now(),
        });
      }
      return;
    }
    case "tool-output-available": {
      // A streaming tool (today: `buildPage`, which reports its delegate's
      // steps) emits one of these PER YIELD, all under the same toolCallId,
      // and the SDK flags every one but the last `preliminary`. They are
      // progress, not calls: counting them inflated `buildPage` to 20 calls
      // for a single build (measured 2026-08-22), which then fired
      // `tool-budget-overage` and `redundant-call-count` on runs where the
      // model had done nothing wrong. The model's own view was always
      // correct — `stepsUsed` stayed at 4 — so the numbers disagreed with
      // each other rather than with reality, which is the expensive kind of
      // wrong measurement.
      if (chunk["preliminary"] === true) return;
      const id = readString(chunk, "toolCallId");
      const entry = id ? state.toolInputs.get(id) : undefined;
      const latencyMs =
        entry !== undefined ? Date.now() - entry.startedAtMs : undefined;
      state.toolCalls.push({
        name: entry?.name ?? "unknown",
        input: entry?.input,
        output: chunk["output"],
        startedAtMs: entry?.startedAtMs,
        latencyMs,
      });
      return;
    }
    case "finish": {
      const reason = readString(chunk, "finishReason");
      if (reason !== undefined) state.finishReason = reason;
      // The server attaches `messageMetadata` (langfuseTraceId + telemetry
      // usage) to the FINISH chunk — not a separate `message-metadata`
      // frame, and under `messageMetadata`, not `metadata`.
      absorbMessageMetadata(chunk["messageMetadata"], state);
      return;
    }
    case "message-metadata": {
      absorbMessageMetadata(chunk["messageMetadata"], state);
      return;
    }
  }
};

/**
 * Pull `langfuseTraceId` + token usage out of a `messageMetadata` object
 * (`{ langfuseTraceId, telemetry: { usage: {...} } }`).
 */
const absorbMessageMetadata = (mm: unknown, state: StreamState): void => {
  if (!isRecord(mm)) return;
  const traceId = readString(mm, "langfuseTraceId");
  if (traceId !== undefined) state.traceId = traceId;
  const telemetry = mm["telemetry"];
  if (isRecord(telemetry)) {
    // Which agent answered + under which profile (see InvokeResult).
    // A zombie-recovery merge emits a SECOND finish frame with
    // `servedBy: "fallback"` — last write wins, which is correct: the
    // fallback produced the visible answer.
    const servedBy = readString(telemetry, "servedBy");
    if (servedBy !== undefined) state.servedBy = servedBy;
    const profileKey = readString(telemetry, "modelProfileKey");
    if (profileKey !== undefined) state.modelProfileKey = profileKey;
  }
  const usage = isRecord(telemetry) ? telemetry["usage"] : undefined;
  if (!isRecord(usage)) return;
  state.usage = {
    inputTokens: readNumber(usage, "inputTokens"),
    outputTokens: readNumber(usage, "outputTokens"),
    totalTokens: readNumber(usage, "totalTokens"),
  };
};

const sumToolLatency = (calls: ToolCallTrace[]): number =>
  calls.reduce((acc, c) => acc + (c.latencyMs ?? 0), 0);

/**
 * Build an `InvokeResult` for a failure path (no stream read). Keeps
 * the `toolLatencyMs` / `modelLatencyMs` fields aligned with the
 * success path so downstream consumers don't need null-checks.
 */
const buildFailure = (
  startedAt: number,
  overrides: Partial<InvokeResult> & { error: string },
): InvokeResult => ({
  text: "",
  toolCalls: [],
  latencyMs: Date.now() - startedAt,
  toolLatencyMs: 0,
  modelLatencyMs: Date.now() - startedAt,
  ...overrides,
});

const readStream = async (
  res: Response,
  startedAt: number,
): Promise<InvokeResult> => {
  const reader = res.body?.getReader();
  if (!reader) {
    return buildFailure(startedAt, {
      httpStatus: res.status,
      error: "No response body",
    });
  }
  const decoder = new TextDecoder();
  const state = createStreamState();
  let buffer = "";

  // eslint-disable-next-line no-await-in-loop -- serial by design: each
  // read() is the next chunk of the same stream, parallelism is not
  // possible at this layer (the TransformStream is inherently ordered).
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split(/\n\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const chunk of parseFrame(frame)) absorbChunk(chunk, state);
    }
  }
  if (buffer.length > 0) {
    for (const chunk of parseFrame(buffer)) absorbChunk(chunk, state);
  }

  const latencyMs = Date.now() - startedAt;
  const toolLatencyMs = sumToolLatency(state.toolCalls);
  const modelLatencyMs = Math.max(0, latencyMs - toolLatencyMs);

  return {
    text: state.textParts.join(""),
    toolCalls: state.toolCalls,
    finishReason: state.finishReason,
    latencyMs,
    toolLatencyMs,
    modelLatencyMs,
    stepsUsed: state.stepsUsed,
    usage: state.usage,
    httpStatus: res.status,
    ...(state.traceId !== undefined ? { traceId: state.traceId } : {}),
    ...(state.servedBy !== undefined ? { servedBy: state.servedBy } : {}),
    ...(state.modelProfileKey !== undefined
      ? { modelProfileKey: state.modelProfileKey }
      : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
};

/**
 * Invoke the chatbot with a single user prompt. Resolves to an
 * `InvokeResult`. Network / HTTP errors are caught and surfaced on
 * the `error` field rather than thrown, so a failed case degrades to
 * an assertion failure (not an abort of the whole run).
 *
 * Pass `conversationId` to run the case against a real conversation
 * row (required for sandbox-backed tools: bash, python,
 * read, …). Stateless invocation (no conversationId) is still
 * supported for suites that don't need tool-side conversation
 * context.
 */
export const invokeChatbot = async (
  prompt: string,
  conversationId?: string,
  opts?: InvokeOptions,
): Promise<InvokeResult> => {
  const startedAt = Date.now();
  const url = `${requireEnv("AI_SERVICE_URL").replace(/\/+$/, "")}/internal/agents/chatbot/invoke`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(opts),
      body: buildBody(prompt, conversationId),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return buildFailure(startedAt, {
        httpStatus: res.status,
        error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
      });
    }
    return await readStream(res, startedAt);
  } catch (err) {
    return buildFailure(startedAt, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
