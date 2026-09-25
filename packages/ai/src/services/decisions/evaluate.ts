import type {
  DecisionAnswer,
  DecisionMissingReason,
  DecisionQuestion,
  DecisionState,
  DecisionTransport,
} from "@fretik/shared/schemas/decisions";
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationModel as EvaluationModel,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from "ai";
import {
  extractGatewayReport,
  gatewayClient,
} from "../../lib/model-registry/transports/gateway";
import {
  extractOpenRouterReport,
  openrouterClient,
} from "../../lib/model-registry/transports/openrouter";
import { traceExternalCall } from "../../lib/trace-tool";

/**
 * The ONE place in the monorepo that calls a decision model.
 *
 * Two experimental surfaces are stacked here — `experimental_evaluate` on the
 * AI SDK's side, the Decisions API (`/api/alpha/decisions`) on OpenRouter's —
 * and either can change shape without a major version. Keeping every caller
 * behind this module means a break is one file to fix rather than a hunt.
 *
 * It is DELIBERATELY outside the model registry. `model_live_state` and every
 * profile derived from it describe chat-completions models: reasoning ladders,
 * cache shapes, `require_parameters`, eligibility floors. A decision model has
 * none of those and does not speak that wire format, so folding it in would
 * teach every profile reader that a profile might describe a thing it cannot
 * serve.
 *
 * Two transports, both zero-data-retention, and not interchangeable:
 * - **OpenRouter**, primary, PINNED to `typesafe/jev-1.13` with the route
 *   constrained to TypeSafe's ZDR endpoint. A threshold is a measurement
 *   against one model; a silently swapped model is a silently moved bar.
 * - **Vercel AI Gateway**, fallback, serving `typesafe-ai/jev` — which
 *   FLOATS. Fine to act on when the primary is down, wrong to calibrate
 *   against, which is why every answer carries the transport that produced it.
 */

const OPENROUTER_MODEL_ID = "typesafe/jev-1.13";
const GATEWAY_MODEL_ID = "typesafe-ai/jev";

/** Below this much time left, a second transport cannot answer before the
 * caller's deadline, and trying only delays the fall-open. */
const FALLBACK_MIN_REMAINING_MS = 250;

/** Exported for `scripts/probe-decisions.ts` only, so the probe sends the
 * production envelope rather than a copy of it. */
export const openrouterModel = (
  sessionId: string | undefined,
): EvaluationModel =>
  openrouterClient().evaluationModel(OPENROUTER_MODEL_ID, {
    // `only` + no fallbacks: the pool is TypeSafe's ZDR route and nothing
    // else. A broader pool is how a request would reach a host that keeps
    // prompts; an empty one is a 404 we see immediately.
    provider: { zdr: true, only: ["typesafe"], allow_fallbacks: false },
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
  });

export const gatewayModel = (): EvaluationModel =>
  gatewayClient().evaluationModel(GATEWAY_MODEL_ID);

export const GATEWAY_PROVIDER_OPTIONS = {
  gateway: { zeroDataRetention: true },
};

/**
 * Our question shape mirrors the SDK's, so this is a copy in spirit — written
 * as an explicit map anyway, because the two CAN drift and a silent
 * structural match is exactly the coupling that breaks on a minor version.
 */
const toSdkQuestion = (question: DecisionQuestion): EvaluationQuestion => {
  switch (question.type) {
    case "boolean":
      return {
        type: "boolean",
        instructions: question.instructions,
        ...(question.criteria ? { criteria: question.criteria } : {}),
      };
    case "choice":
      return {
        type: "choice",
        instructions: question.instructions,
        criteria: question.criteria,
      };
    case "score":
      return {
        type: "score",
        instructions: question.instructions,
        criteria: question.criteria,
      };
  }
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/**
 * Per-answer extras the SDK answer shape does not carry: `confidence` for a
 * choice or a score, the score `legend`. OpenRouter parks them under
 * `providerMetadata.openrouter.answers[id]`. Absent on the gateway today —
 * which callers must read as "not reported", never as zero.
 */
const answerExtras = (
  metadata: unknown,
  id: string,
): { confidence?: number; legend?: Record<string, string> } => {
  const answers = asRecord(asRecord(asRecord(metadata)?.openrouter)?.answers);
  const entry = asRecord(answers?.[id]);
  if (!entry) return {};
  const confidence = finiteNumber(entry.confidence);
  const legendRecord = asRecord(entry.legend);
  const legend = legendRecord
    ? Object.fromEntries(
        Object.entries(legendRecord).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        ),
      )
    : undefined;
  return {
    ...(confidence !== undefined ? { confidence } : {}),
    ...(legend !== undefined ? { legend } : {}),
  };
};

/**
 * Status code of a failed call, wherever the SDK put it: on the error, on its
 * `cause`, or on the last attempt of a retry wrapper.
 */
const statusCodeOf = (error: unknown, depth = 0): number | undefined => {
  if (depth > 4) return undefined;
  const record = asRecord(error);
  if (!record) return undefined;
  const direct = finiteNumber(record.statusCode);
  if (direct !== undefined) return direct;
  return (
    statusCodeOf(record.cause, depth + 1) ??
    statusCodeOf(record.lastError, depth + 1)
  );
};

/**
 * Why a call produced nothing. `invalid_request` is kept apart from every
 * outage: a question the provider refuses will be refused by every retry and
 * every transport, so it never falls back, and it is logged loud — it is our
 * bug, and read as "the provider is down" it would fall open silently forever.
 */
export const classifyFailure = (
  error: unknown,
  aborted: boolean,
): DecisionMissingReason => {
  if (aborted) return "timeout";
  const status = statusCodeOf(error);
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 413 || status === 422) {
    return "invalid_request";
  }
  return "unavailable";
};

export interface ChunkResult {
  answers: Record<string, DecisionAnswer>;
  missing: { id: string; reason: DecisionMissingReason }[];
  transport: DecisionTransport | null;
  modelId?: string;
  inputTokens?: number;
  costUsd?: number;
}

type Attempt =
  | { ok: true; result: ChunkResult }
  | { ok: false; reason: DecisionMissingReason; message: string };

const attempt = async (params: {
  transport: DecisionTransport;
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  sessionId: string | undefined;
  deadline: number;
  trace: Record<string, unknown>;
}): Promise<Attempt> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(0, params.deadline - Date.now()),
  );
  const sdkQuestions: Record<string, EvaluationQuestion> = {};
  for (const [id, question] of Object.entries(params.questions)) {
    sdkQuestions[id] = toSdkQuestion(question);
  }

  try {
    const result = await traceExternalCall(
      "decision",
      {
        ...params.trace,
        transport: params.transport,
        questionCount: Object.keys(sdkQuestions).length,
        state: params.state,
      },
      async () => {
        const raw = await evaluate({
          model:
            params.transport === "openrouter"
              ? openrouterModel(params.sessionId)
              : gatewayModel(),
          state: params.state,
          questions: sdkQuestions,
          // One attempt per transport: a retry has already spent the
          // latency the caller allowed, and falling open is cheaper than a
          // slow right answer.
          maxRetries: 0,
          abortSignal: controller.signal,
          ...(params.transport === "gateway"
            ? { providerOptions: GATEWAY_PROVIDER_OPTIONS }
            : {}),
        });

        const answers: Record<string, DecisionAnswer> = {};
        for (const [id, answer] of Object.entries(raw.answers)) {
          const extras = answerExtras(raw.providerMetadata, id);
          switch (answer.type) {
            case "boolean":
              answers[id] = {
                type: "boolean",
                probability: answer.probability,
              };
              break;
            case "choice":
              answers[id] = {
                type: "choice",
                choice: answer.choice,
                ...(answer.probabilities
                  ? { probabilities: answer.probabilities }
                  : {}),
                ...(extras.confidence !== undefined
                  ? { confidence: extras.confidence }
                  : {}),
              };
              break;
            case "score":
              answers[id] = {
                type: "score",
                score: answer.score,
                ...(answer.probabilities
                  ? { probabilities: answer.probabilities }
                  : {}),
                ...(extras.confidence !== undefined
                  ? { confidence: extras.confidence }
                  : {}),
                ...(extras.legend !== undefined
                  ? { legend: extras.legend }
                  : {}),
              };
              break;
          }
        }
        const report =
          params.transport === "openrouter"
            ? extractOpenRouterReport(raw.providerMetadata)
            : extractGatewayReport(raw.providerMetadata);
        const missing = Object.keys(sdkQuestions)
          .filter((id) => !(id in answers))
          .map((id) => ({ id, reason: "no_answer" as const }));
        const chunk: ChunkResult = {
          answers,
          missing,
          transport: params.transport,
          modelId: raw.response.modelId,
          ...(raw.usage.inputTokens !== undefined
            ? { inputTokens: raw.usage.inputTokens }
            : {}),
          ...(report.costUsd !== undefined ? { costUsd: report.costUsd } : {}),
        };
        return chunk;
      },
      (chunk) => ({
        ...(chunk.costUsd !== undefined ? { costUsd: chunk.costUsd } : {}),
        output: { answers: chunk.answers, missing: chunk.missing },
        metadata: {
          transport: params.transport,
          modelId: chunk.modelId ?? "",
          inputTokens: chunk.inputTokens ?? 0,
        },
      }),
    );
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      reason: classifyFailure(error, controller.signal.aborted),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Ask one chunk of questions about one state, falling back once.
 *
 * NEVER throws: every failure becomes a `missing` entry per question, so the
 * caller falls open on exactly the questions that went unanswered and acts on
 * the rest. The contract of the SDK is all-or-nothing per CALL; a request may
 * be several calls, and one failed call says nothing about its siblings.
 */
export const evaluateChunk = async (params: {
  state: DecisionState;
  questions: Record<string, DecisionQuestion>;
  sessionId?: string;
  deadline: number;
  fallback: boolean;
  trace: Record<string, unknown>;
}): Promise<ChunkResult> => {
  const primary = await attempt({
    transport: "openrouter",
    state: params.state,
    questions: params.questions,
    sessionId: params.sessionId,
    deadline: params.deadline,
    trace: params.trace,
  });
  if (primary.ok) return primary.result;

  if (primary.reason === "invalid_request") {
    console.error(
      `[decisions] invalid request (${String(params.trace.point)}): ${primary.message}`,
    );
  }

  const canFallBack =
    params.fallback &&
    primary.reason !== "invalid_request" &&
    params.deadline - Date.now() >= FALLBACK_MIN_REMAINING_MS;
  if (canFallBack) {
    const secondary = await attempt({
      transport: "gateway",
      state: params.state,
      questions: params.questions,
      sessionId: params.sessionId,
      deadline: params.deadline,
      trace: params.trace,
    });
    if (secondary.ok) return secondary.result;
    console.warn(
      `[decisions] both transports failed (${String(params.trace.point)}): ${primary.reason} / ${secondary.reason}`,
    );
    return {
      answers: {},
      missing: Object.keys(params.questions).map((id) => ({
        id,
        reason: secondary.reason,
      })),
      transport: null,
    };
  }

  console.warn(
    `[decisions] no answer (${String(params.trace.point)}): ${primary.reason}`,
  );
  return {
    answers: {},
    missing: Object.keys(params.questions).map((id) => ({
      id,
      reason: primary.reason,
    })),
    transport: null,
  };
};
