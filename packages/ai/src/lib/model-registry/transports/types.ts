import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
  EndpointStat,
  LiveModelState,
  TransportId,
} from "@fretik/shared/model-registry/types";
import type { ModelProfile, RoleBinding } from "../types";

/**
 * The transport boundary.
 *
 * A transport is a way of reaching a model: a gateway, an aggregator, a
 * first-party API, a URL a customer runs themselves. Each one has its own AI
 * SDK provider package, its own routing dialect and its own response metadata,
 * and none of that belongs in the resolver. What the resolver needs is the
 * three things below — a model, the cost and serving provider behind an answer,
 * and an honest statement of what the dialect cannot express.
 *
 * Two adapters ship today (`gateway`, `openrouter`). The interface is shaped
 * for the two that do not: `scaleway` (Generative APIs, OpenAI-compatible) and
 * `custom` (a base URL and token a team supplies for self-hosted inference).
 * Adding one is a file that implements this interface plus an entry in the
 * registry — no change to the resolver, the registry or the picker.
 */

/**
 * A reasoning request in product terms, before any vendor dialect.
 *
 * The two shapes are not interchangeable and the distinction is load-bearing:
 * an effort ladder is a hint the model interprets, a token budget is a hard
 * allowance that has been the only thing keeping some models from spending an
 * entire turn thinking (measured: 38 679 reasoning tokens in one MiniMax step).
 * A transport that can express one but not the other must say so rather than
 * quietly downgrade — that is what `canExpressReasoning` is for.
 */
export type ReasoningRequest =
  | { kind: "off" }
  | {
      kind: "effort";
      // `max` included since 2026-08-30. It was missing because the OpenRouter
      // SDK's union stops at `xhigh`, and that clamp had been applied to the
      // SHARED envelope every transport derives from — so one provider
      // package's typing removed the top rung from the gateway and Scaleway
      // too, neither of which has the constraint. The API itself accepts it:
      // sent to `deepseek-v4-flash-0731`, `effort: "max"` returns 200, and an
      // invalid value is refused with the API's own list, which ends in `max`.
      effort: "max" | "xhigh" | "high" | "medium" | "low" | "minimal";
    }
  | { kind: "budget"; maxTokens: number };

/** What one call needs from the transport, in transport-neutral terms. */
export interface TransportRequest {
  /** The model id ON THIS TRANSPORT — never a translation of another's. */
  modelId: string;
  binding: RoleBinding;
  profile: ModelProfile;
  /** Live row, when the model has one. Absent means code defaults only. */
  live?: LiveModelState;
  /**
   * Endpoints known for this model on this transport. Two things need them:
   * a dialect that can only express exclusion as an allow-list (removing one
   * host means enumerating the others), and every capability question, which is
   * answered from `supported_parameters` rather than from a table of families
   * somebody has to remember to extend.
   */
  endpoints: readonly EndpointStat[];
  /**
   * The reasoning envelope the role resolved, already reduced to a level or a
   * budget. Adapters render it; they never recompute it, so a model that moves
   * between transports keeps the allowance it was measured with.
   */
  reasoning?: ReasoningRequest;
}

/**
 * What a transport can carry for one model, derived from the endpoints' own
 * `supported_parameters`. Every field is a question a catalogue can answer, so
 * a family nobody has heard of yet is graded the same way as a familiar one.
 */
export interface TransportCapabilities {
  /** Any endpoint at all — an empty pool answers every other question `false`. */
  routable: boolean;
  /** Tool calling is advertised by EVERY allowed endpoint, not just one. */
  tools: boolean;
  /** The reasoning envelope can be steered rather than left to a default. */
  reasoning: boolean;
  /** Quarantines are enforceable: the dialect can express this exclusion. */
  exclusions: boolean;
  /** Human-readable gaps, for the alert and the CLI scorecard. */
  gaps: string[];
}

/** What we learn about an answer after the fact, normalised across dialects. */
export interface GenerationReport {
  /** Exact USD charged for this call, when the transport reports it. */
  costUsd?: number;
  /** The upstream that actually served it — the quarantine subject. */
  servingProvider?: string;
  /** The transport's own id for the generation, for its dashboards. */
  generationId?: string;
}

/**
 * What one finished call consumed, as the AI SDK normalises it.
 *
 * `cachedInputTokens` is separate because it bills at its own rate wherever a
 * transport reports it — and `undefined` means the transport did not say, which
 * is not the same as none.
 */
export interface CallUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface TransportAdapter {
  readonly id: TransportId;

  /** Build the model instance, routing dialect included. */
  buildModel(request: TransportRequest): LanguageModelV4;

  /**
   * Which parts of the request this transport can carry WITHOUT LOSS, decided
   * from what the endpoints advertise rather than from any list of families or
   * model names. A model family that did not exist when this was written has to
   * work on the day it appears in a catalogue; anything hand-maintained here
   * would instead need a release.
   *
   * A gap is why a model stays on another transport: silently dropping a
   * thinking budget, or clamping a ladder's top rung, changes what a team paid
   * for and surfaces as a quality regression nobody can trace back.
   */
  capabilities(request: TransportRequest): TransportCapabilities;

  /** Pull cost, serving provider and generation id out of `providerMetadata`. */
  extractReport(metadata: unknown): GenerationReport;

  /**
   * What a call COST, for a transport that does not put a price on the wire.
   *
   * Optional, and implemented by exactly the transports whose `extractReport`
   * cannot answer: an aggregator bills per call and reports the figure, while a
   * direct provider bills on the account and reports nothing at all — measured
   * 2026-08-30, a Scaleway generation returns `providerMetadata: {scaleway: {}}`
   * with no cost field and no cost header, and its raw `usage` carries token
   * counts alone.
   *
   * Without this the alternative is not "no number", it is a WRONG one:
   * Langfuse falls back to its own model-price table, which knows nothing about
   * who served the call, so a direct provider's traffic lands on a dashboard
   * either at zero — reading as free — or at some other host's rate.
   *
   * A figure from here is DERIVED, never measured, and the caller labels it as
   * such. It never competes with a reported cost: it is consulted only when
   * `extractReport` returned none.
   */
  estimateCostUsd?(
    request: TransportRequest,
    usage: CallUsage,
  ): number | undefined;
}
