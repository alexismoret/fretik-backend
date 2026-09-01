/**
 * Runtime corruption detectors (AI SDK middleware) — the breaker's eyes.
 *
 * `@fretik/shared` `services/model-registry/breaker.ts` can pull a misbehaving
 * upstream out of a model's pool within seconds and with no deploy. It can only
 * do that if something WATCHES the stream, and this is that thing: four
 * literal, judgement-free checks over the text and the finish reason of every
 * generation, filed against the host that actually served the call.
 *
 * ONE INCIDENT PER GENERATION PER KIND, without exception. The breaker counts
 * ROWS as distinct generations — that is what makes "three incidents" mean
 * "three separate answers went wrong" — so a detector that filed twice for one
 * stream would let a single pathological response trip a quarantine on its own.
 * Everything seen inside a call is accumulated and filed once at the end, with
 * the occurrence count in the evidence.
 *
 * EVIDENCE CARRIES CODEPOINTS, COUNTS, FINISH REASONS AND LENGTHS — never the
 * text. These streams are customer documents and conversations; a corruption
 * detector is not a licence to copy them into an infra table.
 *
 * NOTHING HERE MAY COST A TURN. Filing is fire-and-forget behind a `.catch`,
 * the rate limiter is in-process, and the hot path is two regex `exec` calls
 * over each text delta.
 */
import type {
  JSONValue,
  LanguageModelV4FinishReason,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import {
  scanForbiddenCodepoints,
  type ForbiddenScan,
} from "@fretik/shared/lib/text-integrity";
import type { TransportId } from "@fretik/shared/model-registry/types";
import { reportIncident } from "@fretik/shared/services/model-registry/breaker";
import type { RecordIncidentInput } from "@fretik/shared/services/model-registry/incidents";
import { TransformStream } from "node:stream/web";
import { extractGatewayReport } from "./model-registry/transports/gateway";
import { extractOpenRouterReport } from "./model-registry/transports/openrouter";
import { extractScalewayReport } from "./model-registry/transports/scaleway";

type IncidentKind = RecordIncidentInput["kind"];

export interface DetectorContext {
  /** The stable key teams store. The raw model id is the fallback. */
  profileKey?: string;
  /** Which transport served the call. */
  transport?: TransportId;
}

/**
 * Same threshold and same rule as `lib/langfuse-cost.ts`'s `SUSPECT_CUT_AFTER_MS`:
 * a long call that ends on a finish reason NOBODY CHOSE. `stop` and `tool-calls`
 * are the model deciding, `length` is a budget doing its job; everything else —
 * including the `null` OpenRouter sends when a watchdog closes the socket, which
 * lands as `other` — is the call ending without either. That module does not
 * export the constant, so the two are kept in step by hand: change one and the
 * definition of "cut" has been split in half.
 */
const SUSPECT_CUT_AFTER_MS = 60_000;

const suspectCut = (
  finishReason: LanguageModelV4FinishReason | undefined,
  startedAt: number,
): { generationMs: number } | undefined => {
  const generationMs = Date.now() - startedAt;
  if (generationMs < SUSPECT_CUT_AFTER_MS) return undefined;
  const unified = finishReason?.unified;
  if (unified === "stop" || unified === "tool-calls" || unified === "length") {
    return undefined;
  }
  return { generationMs };
};

const readString = (value: JSONValue | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * The upstream that ACTUALLY served the call — the only thing a quarantine can
 * be about. Both transports route one model id to a different company call to
 * call, and neither the id nor OTel's `gen_ai.provider.name` says which:
 * `lib/langfuse-cost.ts` reads the same field for the same reason, and
 * recovering it after the fact means replaying a generation log by hand.
 *
 * Read through the adapters rather than by hand, so the name a quarantine is
 * filed under is the same string, normalised the same way, as the one the pool
 * is written with. A near-match here — `DeepInfra` against `deepinfra` — is a
 * quarantine that files cleanly and then excludes nobody.
 */
const servingProvider = (
  metadata: SharedV4ProviderMetadata | undefined,
): string | undefined =>
  extractGatewayReport(metadata).servingProvider ??
  extractOpenRouterReport(metadata).servingProvider ??
  // Scaleway reports no provider — one host, nothing to disambiguate — so its
  // adapter names the constant when the response is its own. Missing from this
  // chain until 2026-09-01, which meant every Scaleway finding was dropped as
  // unattributable: the breaker quarantines a PROVIDER, so the one transport
  // whose corruption could never be caught was the direct one.
  extractScalewayReport(metadata).servingProvider;

/** The upstream's own id for the call, so an incident stays replayable. */
const generationIdOf = (
  metadata: SharedV4ProviderMetadata | undefined,
  responseId: string | undefined,
): string | undefined =>
  readString(metadata?.gateway?.generationId) ?? responseId;

/**
 * At most 5 filings a minute per (model, provider, kind), in this process.
 *
 * An upstream that starts corrupting EVERY answer would otherwise write a row
 * per turn on every replica, and the breaker needs 2 to 5 corroborating
 * generations — a hundred more buy nothing and cost a table. The drop is safe in
 * one direction only, which is the one that matters: it can DELAY a quarantine,
 * never cause one.
 */
const RATE_LIMIT_PER_MINUTE = 5;
const RATE_WINDOW_MS = 60_000;

interface Bucket {
  /** Filing timestamps still inside the window. */
  times: number[];
  dropped: number;
  loggedAt: number;
}

const buckets = new Map<string, Bucket>();

let droppedFilings = 0;
let unattributedFindings = 0;
let unattributedLogged = false;

/** Counters for whoever asks why an incident they expected is not in the table. */
export const detectorStats = (): {
  rateLimited: number;
  unattributed: number;
} => ({ rateLimited: droppedFilings, unattributed: unattributedFindings });

const allowFiling = (key: string, now: number): boolean => {
  const bucket = buckets.get(key) ?? { times: [], dropped: 0, loggedAt: 0 };
  bucket.times = bucket.times.filter((at) => now - at < RATE_WINDOW_MS);
  if (bucket.times.length >= RATE_LIMIT_PER_MINUTE) {
    bucket.dropped += 1;
    droppedFilings += 1;
    if (now - bucket.loggedAt >= RATE_WINDOW_MS) {
      bucket.loggedAt = now;
      console.warn(
        `[model-detectors] rate-limited ${bucket.dropped.toString()} filing(s) for ${key} — more than ${RATE_LIMIT_PER_MINUTE.toString()} a minute. The breaker already has what it needs.`,
      );
    }
    buckets.set(key, bucket);
    return false;
  }
  bucket.times.push(now);
  buckets.set(key, bucket);
  return true;
};

const fileIncident = (input: RecordIncidentInput): void => {
  if (
    !allowFiling(
      `${input.modelKey}|${input.provider}|${input.kind}`,
      Date.now(),
    )
  ) {
    return;
  }
  // FIRE AND FORGET. A turn must never fail, slow down or wait because its own
  // quality monitoring did. `reportIncident` swallows its own errors; the catch
  // covers whatever would still escape as a rejected promise.
  void reportIncident(input).catch((err: unknown) => {
    console.error(
      "[model-detectors] filing failed:",
      err instanceof Error ? err.message : err,
    );
  });
};

/** Only the END of a turn is ever inspected, so this is all the text held. */
const TAIL_CHARS = 64;

const THINK_TAG = /<\/?think>/g;
const CODE_FENCE = /```/g;
const TRAILING_WHITESPACE = /\s+$/u;

/**
 * A turn that stopped MID-SENTENCE, defined narrowly enough that a false
 * positive takes real work.
 *
 * After trailing whitespace is trimmed, the last character must be a letter, a
 * digit, a comma or a semicolon. Everything else is read as a finished thought,
 * and each tolerance is there for a turn we actually see:
 *
 * - terminal punctuation (`.` `!` `?` `…`) ends a sentence;
 * - a COLON is the shape of a legitimate hand-off — "Je vérifie la météo:" then
 *   a tool call — and is the single most common ending on this path;
 * - a closing bracket, quote or parenthesis closes what it opened;
 * - an UNTERMINATED fence is code the model may still be emitting, and code
 *   legitimately ends on a letter or a digit (`const total = 0`). A CLOSED
 *   fence needs no special case: its last character is a backtick, which is not
 *   a letter, digit, comma or semicolon.
 *
 * A comma or a semicolon is the opposite: no sentence ends on one, so text that
 * does was cut.
 */
const MID_SENTENCE_TAIL = /[\p{L}\p{N},;]$/u;

interface CallState {
  startedAt: number;
  /** `U+XXXX` → occurrences over the whole generation. */
  codepoints: Map<string, number>;
  codepointTotal: number;
  /** Threaded back from the scanner verbatim; its length is the scanner's business. */
  carry: string;
  thinkTags: number;
  /** ``` markers so far. An odd count means the text ends inside a fence. */
  fences: number;
  textLength: number;
  /** Last `TAIL_CHARS` characters — the only text this module holds. */
  tail: string;
  responseId: string | undefined;
  /**
   * The most recent metadata any part carried. A CUT stream never reaches its
   * `finish` part, so waiting for that one to name the upstream would leave the
   * kind that most needs attribution with none.
   */
  providerMetadata: SharedV4ProviderMetadata | undefined;
  filed: Set<IncidentKind>;
}

const newCallState = (): CallState => ({
  startedAt: Date.now(),
  codepoints: new Map(),
  codepointTotal: 0,
  carry: "",
  thinkTags: 0,
  fences: 0,
  textLength: 0,
  tail: "",
  responseId: undefined,
  providerMetadata: undefined,
  filed: new Set(),
});

const partMetadata = (
  part: LanguageModelV4StreamPart,
): SharedV4ProviderMetadata | undefined =>
  "providerMetadata" in part ? part.providerMetadata : undefined;

/**
 * Occurrences of `pattern` that END inside the new text, the window being the
 * previous tail plus that text. A match lying wholly in the tail was counted
 * when the tail was new, so this is exact and a tag or a fence split across two
 * deltas is still seen once.
 */
const countNew = (
  pattern: RegExp,
  window: string,
  tailLength: number,
): number => {
  pattern.lastIndex = 0;
  let count = 0;
  for (
    let match = pattern.exec(window);
    match !== null;
    match = pattern.exec(window)
  ) {
    if (match.index + match[0].length > tailLength) count += 1;
  }
  return count;
};

/**
 * Fold one text delta into the call's state.
 *
 * THE HOT PATH. A clean delta costs four `exec` calls that return null, one
 * join with a tail of at most `TAIL_CHARS` characters and one slice back down
 * to it — no array, map or object is built unless something is actually found.
 */
const observeText = (state: CallState, text: string): void => {
  if (text.length === 0) return;
  const scan: ForbiddenScan = scanForbiddenCodepoints(text, state.carry);
  state.carry = scan.carry;
  if (scan.total > 0) {
    state.codepointTotal += scan.total;
    for (const [codepoint, count] of Object.entries(scan.hits)) {
      state.codepoints.set(
        codepoint,
        (state.codepoints.get(codepoint) ?? 0) + count,
      );
    }
  }
  const window = state.tail + text;
  state.thinkTags += countNew(THINK_TAG, window, state.tail.length);
  state.fences += countNew(CODE_FENCE, window, state.tail.length);
  state.textLength += text.length;
  state.tail = window.slice(-TAIL_CHARS);
};

const endsMidSentence = (state: CallState): boolean => {
  if (state.fences % 2 === 1) return false;
  const trimmed = state.tail.replace(TRAILING_WHITESPACE, "");
  return trimmed.length > 0 && MID_SENTENCE_TAIL.test(trimmed);
};

interface Outcome {
  modelId: string;
  providerMetadata: SharedV4ProviderMetadata | undefined;
  finishReason: LanguageModelV4FinishReason | undefined;
  responseId: string | undefined;
}

interface Finding {
  kind: IncidentKind;
  evidence: Record<string, number | string>;
}

const findingsFor = (state: CallState, outcome: Outcome): Finding[] => {
  const findings: Finding[] = [];
  if (state.codepointTotal > 0) {
    findings.push({
      kind: "forbidden-codepoints",
      evidence: {
        ...Object.fromEntries(state.codepoints),
        total: state.codepointTotal,
      },
    });
  }
  if (state.thinkTags > 0) {
    // The strippers downstream remove these; this only counts them, and it
    // counts the raw tag rather than anything they leave behind — a detector
    // coupled to a repair stops seeing the defect the day the repair changes.
    findings.push({ kind: "think-leak", evidence: { tags: state.thinkTags } });
  }
  if (
    outcome.finishReason?.unified === "tool-calls" &&
    state.textLength > 0 &&
    endsMidSentence(state)
  ) {
    findings.push({
      kind: "truncated-at-tool-call",
      evidence: { finishReason: "tool-calls", textLength: state.textLength },
    });
  }
  const cut = suspectCut(outcome.finishReason, state.startedAt);
  if (cut) {
    findings.push({
      kind: "upstream-cut",
      evidence: {
        finishReason:
          outcome.finishReason?.raw ??
          outcome.finishReason?.unified ??
          "absent",
        generationMs: cut.generationMs,
      },
    });
  }
  return findings;
};

const finalize = (
  state: CallState,
  ctx: DetectorContext,
  outcome: Outcome,
): void => {
  const findings = findingsFor(state, outcome);
  if (findings.length === 0) return;

  const provider = servingProvider(outcome.providerMetadata);
  if (provider === undefined) {
    // A quarantine needs a subject. Without one there is nothing to remove from
    // a pool, and a row naming no host would only be noise a human has to sift.
    unattributedFindings += findings.length;
    if (!unattributedLogged) {
      unattributedLogged = true;
      console.warn(
        `[model-detectors] ${findings.map((f) => f.kind).join(", ")} on ${outcome.modelId}, but providerMetadata names no serving upstream — nothing filed. Later occurrences are counted in detectorStats() and not logged again.`,
      );
    }
    return;
  }

  const modelKey = ctx.profileKey ?? outcome.modelId;
  const transport = ctx.transport ?? "gateway";
  const generationId = generationIdOf(
    outcome.providerMetadata,
    outcome.responseId,
  );
  for (const finding of findings) {
    if (state.filed.has(finding.kind)) continue;
    state.filed.add(finding.kind);
    fileIncident({
      modelKey,
      provider,
      transport,
      kind: finding.kind,
      evidence: finding.evidence,
      ...(generationId !== undefined ? { generationId } : {}),
    });
  }
};

/**
 * Watch one model's generations and file what they show.
 *
 * State is PER CALL, created inside each wrap: the middleware object is built
 * once per model and shared by every concurrent turn, so anything held on the
 * closure would count one conversation's defects against another's.
 */
export const detectorMiddleware = (
  ctx: DetectorContext,
): LanguageModelV4Middleware => ({
  specificationVersion: "v4",
  wrapGenerate: async ({ doGenerate, model }) => {
    const state = newCallState();
    const result = await doGenerate();
    for (const part of result.content) {
      if (part.type === "text") observeText(state, part.text);
    }
    finalize(state, ctx, {
      modelId: model.modelId,
      providerMetadata: result.providerMetadata,
      finishReason: result.finishReason,
      responseId: result.response?.id,
    });
    return result;
  },
  wrapStream: async ({ doStream, model }) => {
    const state = newCallState();
    const { stream, ...rest } = await doStream();
    let finished = false;
    const watched = stream.pipeThrough(
      new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>(
        {
          transform: (part, controller) => {
            const metadata = partMetadata(part);
            if (metadata !== undefined) state.providerMetadata = metadata;
            if (part.type === "text-delta") {
              observeText(state, part.delta);
            } else if (part.type === "response-metadata") {
              state.responseId = part.id;
            } else if (part.type === "finish") {
              finished = true;
              finalize(state, ctx, {
                modelId: model.modelId,
                providerMetadata: state.providerMetadata,
                finishReason: part.finishReason,
                responseId: state.responseId,
              });
            }
            controller.enqueue(part);
          },
          flush: () => {
            // A stream that closes with no `finish` part is the shape a cut
            // takes on the wire. An absent finish reason is read exactly as
            // `lib/langfuse-cost.ts` reads it: nobody chose to stop.
            if (finished) return;
            finalize(state, ctx, {
              modelId: model.modelId,
              providerMetadata: state.providerMetadata,
              finishReason: undefined,
              responseId: state.responseId,
            });
          },
        },
      ),
    );
    return { stream: watched, ...rest };
  },
});
