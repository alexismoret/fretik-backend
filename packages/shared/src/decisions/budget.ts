import { countTokens } from "../lib/token-estimate";
import {
  DECISION_CHUNK_QUESTIONS,
  type DecisionQuestion,
  type DecisionState,
  type DecisionStateValue,
} from "../schemas/decisions";
import type { DecisionPointSpec } from "./points";

/**
 * What goes to the decision model, and in how many calls.
 *
 * Two limits come from the provider — 32K tokens for the state plus the
 * longest single question, 64K for the state plus all of them — and one comes
 * from quality: accuracy falls as the state fills with material the question
 * does not need. So the state is an ALLOW-LIST cut to a per-point budget, and
 * only then are the questions packed into calls.
 */

/**
 * The model's tokenizer is not published. `countTokens` is exact for
 * o200k_base, which is a proxy here, so every estimate is padded: a request
 * that overflows is a provider error and a fall-open, and 15 % of headroom is
 * far cheaper than that.
 */
export const TOKEN_MARGIN = 1.15;
export const STATE_PLUS_QUESTION_LIMIT = 32_000;
export const STATE_PLUS_QUESTIONS_LIMIT = 64_000;

/**
 * No single value outweighs this. A summary is capped near 1 000 characters at
 * extraction; a custom text field or a connector payload is not, and one long
 * value would otherwise crowd every other fact out of the budget.
 */
export const MAX_VALUE_CHARS = 2_000;

export const estimateTokens = (value: unknown): number =>
  Math.ceil(countTokens(JSON.stringify(value)) * TOKEN_MARGIN);

const admits = (entry: string, key: string): boolean =>
  entry.endsWith(".") ? key.startsWith(entry) : key === entry;

const clip = (value: DecisionStateValue): DecisionStateValue => {
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
    return `${value.slice(0, MAX_VALUE_CHARS)}…`;
  }
  if (Array.isArray(value)) {
    let total = 0;
    const kept: string[] = [];
    for (const item of value) {
      total += item.length;
      if (total > MAX_VALUE_CHARS) break;
      kept.push(item);
    }
    return kept;
  }
  return value;
};

export interface FittedState {
  state: DecisionState;
  /** Keys that were present but did not go out, and why. */
  dropped: { key: string; reason: "not_admitted" | "content" | "budget" }[];
  tokens: number;
}

/**
 * Cut a raw state down to what this point may send.
 *
 * Order is the registry's `admit` order, so when the budget binds it is the
 * least telling facts that go. Keys matched by a prefix entry keep the order
 * they arrived in. A key that no entry admits never leaves — including every
 * key a future resolver adds before someone decides it belongs in a decision.
 */
export const fitState = (
  spec: DecisionPointSpec,
  raw: DecisionState,
  options: { redactContent: boolean },
): FittedState => {
  const dropped: FittedState["dropped"] = [];
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const entry of spec.state.admit) {
    for (const key of Object.keys(raw)) {
      if (!seen.has(key) && admits(entry, key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  for (const key of Object.keys(raw)) {
    if (!seen.has(key)) dropped.push({ key, reason: "not_admitted" });
  }

  const state: DecisionState = {};
  let tokens = estimateTokens(state);
  for (const key of ordered) {
    if (
      options.redactContent &&
      spec.state.content.some((entry) => admits(entry, key))
    ) {
      dropped.push({ key, reason: "content" });
      continue;
    }
    const value = raw[key];
    if (value === undefined) continue;
    const clipped = clip(value);
    const cost = estimateTokens({ [key]: clipped });
    if (tokens + cost > spec.state.maxTokens) {
      dropped.push({ key, reason: "budget" });
      continue;
    }
    state[key] = clipped;
    tokens += cost;
  }
  return { state, dropped, tokens };
};

export interface ChunkPlan {
  chunks: Record<string, DecisionQuestion>[];
  /** Questions that cannot be asked even alone: state + this question is
   * past the provider's 32K. They come back `missing: too_large`. */
  tooLarge: string[];
}

/**
 * Pack questions into calls against one state: at most `chunkSize` a call,
 * and never past the 64K ceiling for state plus questions.
 *
 * Greedy in the order given, which is the caller's order — a gate lists its
 * workflows in a stable order, so the same event always splits the same way
 * and a failure is reproducible.
 */
export const planChunks = (
  questions: Record<string, DecisionQuestion>,
  stateTokens: number,
  chunkSize: number = DECISION_CHUNK_QUESTIONS,
): ChunkPlan => {
  const chunks: Record<string, DecisionQuestion>[] = [];
  const tooLarge: string[] = [];
  let current: Record<string, DecisionQuestion> = {};
  let currentCount = 0;
  let currentTokens = stateTokens;

  for (const [id, question] of Object.entries(questions)) {
    const cost = estimateTokens({ [id]: question });
    if (stateTokens + cost > STATE_PLUS_QUESTION_LIMIT) {
      tooLarge.push(id);
      continue;
    }
    if (
      currentCount >= chunkSize ||
      currentTokens + cost > STATE_PLUS_QUESTIONS_LIMIT
    ) {
      chunks.push(current);
      current = {};
      currentCount = 0;
      currentTokens = stateTokens;
    }
    current[id] = question;
    currentCount += 1;
    currentTokens += cost;
  }
  if (currentCount > 0) chunks.push(current);
  return { chunks, tooLarge };
};
