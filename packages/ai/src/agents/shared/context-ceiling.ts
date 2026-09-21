import { countCachedTokens } from "@fretik/shared/lib/token-estimate";
import type { StopCondition, ToolSet } from "ai";
import { parseIntEnv } from "./env";

/**
 * The absolute size a working context is allowed to reach before the turn ends
 * and the work resumes on a summary.
 *
 * ## Why an absolute number, and not a fraction of the window
 *
 * Because the window is not the constraint. The run that produced this file
 * (`01a0af4e-…`, 2026-09-17) peaked at 200 480 tokens on a model whose
 * effective window is 997 952 — a fifth of `compactConversation`'s threshold,
 * which is derived from that window and therefore never fired. Forty-two
 * minutes, ~6.1M tokens, no deliverable, and every existing brake correctly
 * silent: none of them measures context.
 *
 * Two things do bite well before a window does:
 *
 *  - **Accuracy.** LOCA-bench (arXiv:2602.07962) measures the same families we
 *    serve falling off between 64K and 128K — DeepSeek-V3.2 from 45.3% at 64K
 *    to 10.7% at 128K, Claude-4.5-Opus from 65.3% to 34.0%. Our agent spent its
 *    last 25 steps above 100K. Chroma's "Context Rot" (18 models) reaches the
 *    same place from the other side: one distractor is enough.
 *  - **Price.** An accumulating prefix in a tool loop is Θ(n²). Measured on
 *    that run: steps 26-50 cost 3 865 445 input tokens against 1 613 362 for
 *    steps 1-25 — same step count, 2.4× the bill and 2.4× the latency.
 *
 * It is GLOBAL, not per-model, because the accuracy fall is not a per-model
 * fact worth a per-model number: at 128K DeepSeek is at 10.7% and Opus at
 * 34.0% — both unusable, and nothing we can measure separates them usefully. A
 * per-model override is a registry field the day an eval produces a value for
 * it; until then it would be a column nobody writes, and the registry has
 * already deleted 22 hand-kept profiles for being staler than the derived rows.
 *
 * ## Why 180 000 and not the 100 000 this shipped with
 *
 * 100 000 came from two published sources — Anthropic's default trigger for
 * `clear_tool_uses_20250919`, and the middle of the measured accuracy fall —
 * and from no measurement of our own traffic or our own summariser. Both were
 * added on 2026-09-18 and both argue the other way.
 *
 * **What it costs.** Replaying 62 128 production chat generations over 30 days
 * (`scripts/measure-context-distribution.ts`) through the mechanism, turn by
 * turn: a 100 000 ceiling spends 91.7% of what an uncapped run would, and
 * 180 000 spends 96.0%. So the whole saving being given up is **4.3 points of
 * the input-token bill** — on traffic that is 59.5% cache reads, which makes
 * the money smaller still. It buys the removal of **77% of all compactions**
 * (316 → 73 over those 30 days), and cuts the conversations that are ever cut
 * at all from 6.8% to 1.7%.
 *
 * **What it buys.** Compaction at this size is not a good trade, measured.
 * `lc-recall-120k` + `lc-intent-120k`, ten repeats on the default model and
 * four on two others, comparing a disarmed ceiling against 100 000:
 *
 * | model              | uncapped      | capped at 100 000 |
 * | ------------------ | ------------- | ----------------- |
 * | deepseek-v4-flash  | 0.950 / 7.1s  | 0.970 / **51.0s** |
 * | zai-glm-5-3-flash  | 1.000 / 10.1s | 0.958 / **40.4s** |
 * | gpt-5.6-luna       | 0.900 / 6.8s  | 0.858 / **48.2s** |
 *
 * (correctness / p50 time-to-first-token.) Cutting at 120 000 costs 34 to 44
 * seconds before the first token and returns no accuracy for it — it is level
 * on one model and behind on two. At 180 000 the same cases carry their
 * history whole and score 1.000 / 1.000 / 0.900 at 6.8-12.0s.
 *
 * Above the new line compaction still earns its place, which is why the line
 * exists at all rather than moving to the window: at 340 000 the capped arms
 * spend 5-22% of the uncapped bill, and the wide-cut arm is the one that
 * scores best on GLM (1.000 against 0.700 for the narrow cut).
 *
 * **What this does NOT establish.** Both eval families are recall-shaped —
 * "what did you know" — which is exactly the shape that favours keeping the
 * raw history and the shape a lossy summary fails first. LOCA-bench measures
 * something else (retrieval among distractors at a fixed budget) and still
 * says accuracy falls with size. Nothing here measures a reasoning-heavy task
 * at 144 000 tokens of history, so 180 000 is supported for recall and
 * unproven for everything else. That is why it stayed a tunable.
 *
 * Tunable via `AGENT_CONTEXT_CEILING_TOKENS` (default 180 000, range
 * [20 000, 1 000 000]) — the knob the evals turn, and the rollback. A value
 * below `MIN_RESOLVED_CEILING_TOKENS` still lowers the compaction cap, but the
 * ceiling itself is clamped there: under the prompt-plus-schemas baseline a
 * ceiling ends every turn at step zero without reducing anything. On a narrow
 * model the number never applies as written — `resolveContextCeiling` bounds
 * it by the window, so a 128 000-token model resolves to ~104 000 whatever is
 * configured here.
 */
export const AGENT_CONTEXT_CEILING_TOKENS = parseIntEnv(
  "AGENT_CONTEXT_CEILING_TOKENS",
  { fallback: 180_000, min: 20_000, max: 1_000_000 },
);

/** The shape the ceiling needs from a step — structural, so a test can build one. */
export interface ContextCeilingStep {
  usage?: { inputTokens?: number | undefined } | undefined;
}

/**
 * Locally estimated context size, keyed on the SDK's own `steps` array.
 *
 * `stopWhen` receives `{ steps }` and nothing else — verified in `ai@7`'s
 * `.d.ts`, there is no runtime context to reach through. But `prepareStep`
 * receives `messages` AND the SAME array object (`ai@7` `dist/index.js`:
 * `prepareStep({ model, steps, … })` at the top of the step, then
 * `isStopConditionMet({ stopConditions, steps })` at the bottom of it), so the
 * estimate crosses from one to the other through the array's identity. Same
 * pattern, and the same reason, as `identities` in `agent-set.ts`; the entries
 * die with the run that holds them.
 */
interface ContextEstimate {
  /** Instructions + history, in tokens. The silent-provider fallback. */
  total: number;
  /** History alone — the half the prefix is derived from. */
  historyTokens: number;
  /** Which agent this step belongs to, so the prefix lands in the right bucket. */
  agentId: string | undefined;
}

const estimates = new WeakMap<object, ContextEstimate>();

/** Models already reported as silent — one line each, not one per step. */
const silentModels = new Set<string>();

/**
 * Record what the call about to be made will carry. Called from `prepareStep`.
 *
 * Two numbers, not one. The total is what the ceiling falls back to when a
 * provider reports nothing. The HISTORY half is what makes the prefix
 * measurable: subtract it from what the provider then bills and the remainder
 * is everything the request carries that is not conversation — the
 * instructions and the tool schemas. See `agentPrefixTokens`.
 *
 * `instructions` and `messages` are everything `prepareStep` is handed, so the
 * tool schemas are still absent from the total here; that bias only matters
 * for the silent-provider fallback, where an under-count is a late brake
 * rather than a spurious one.
 */
export const recordContextEstimate = (
  steps: object,
  // `Instructions` in the SDK is a string OR an array of system messages, and
  // both shapes reach the wire as prompt bytes.
  instructions: unknown,
  messages: readonly unknown[],
  agentId?: string,
): void => {
  const instructionTokens =
    typeof instructions === "string"
      ? countCachedTokens(instructions)
      : instructions === undefined
        ? 0
        : countCachedTokens(JSON.stringify(instructions));
  let historyTokens = 0;
  for (const message of messages) {
    historyTokens += countCachedTokens(JSON.stringify(message));
  }
  estimates.set(steps, {
    total: instructionTokens + historyTokens,
    historyTokens,
    agentId,
  });
};

/**
 * What a request carries before any conversation: the resolved instructions
 * plus every tool schema.
 *
 * MEASURED, never declared. It was a constant for one afternoon — 35 000, read
 * off `scripts/measure-system-prompt-tokens.ts` — and a constant is wrong here
 * for the reason every constant about a prompt is wrong: the prompt changes,
 * the tool set changes, and nothing makes the number follow. The compaction cap
 * depends on it, so a stale figure silently re-opens the gap it exists to
 * close.
 *
 * The measurement costs nothing because the request already reports its own
 * size: `usage.inputTokens` minus the history we counted going in IS the
 * prefix, available on every step of every turn. The maximum is kept rather
 * than the mean — subtracting a larger prefix compacts earlier, which is the
 * direction that fails safe — and samples outside a plausible band are dropped,
 * so one truncated report cannot pin the meter.
 *
 * ## Why this is per-process and NOT in Redis
 *
 * It is a property of the deployed IMAGE — this prompt, this tool set — not of
 * a user, a team or a conversation. Every replica running the same image
 * converges to the same number from its own traffic, so sharing it would buy
 * agreement on a value nobody disagrees about, at the price of a round trip on
 * the path that decides whether to compact, plus a cache to invalidate on every
 * deploy and a behaviour to define for when Redis is down. Contrast the pieces
 * that genuinely ARE shared and do go through the database: the checkpoint's
 * advisory lock and unique index, which two replicas can race on for one
 * conversation, and the workflow steering message's deterministic id, which two
 * replicas must agree on to the byte.
 *
 * What per-process DOES cost is a warm-up: the first turn a replica serves has
 * no measurement yet. That window is made safe by direction rather than by
 * sharing — `seededPrefixes` holds a deliberate OVER-estimate, and
 * over-estimating the prefix compacts early (a summary nobody needed) where
 * under-estimating compacts late (a turn that dies on arrival).
 */
const observedPrefixes = new Map<string, number>();

/**
 * Deterministic build-time floor, identical on every replica of an image.
 * Kept apart from `observedPrefixes` on purpose: it is an over-estimate, and
 * feeding an over-estimate into a max-kept meter would pin it high for the life
 * of the process, which is exactly the staleness this whole meter avoids.
 */
const seededPrefixes = new Map<string, number>();

/** Above this a "prefix" is a mis-read, not a prompt. */
const MAX_PLAUSIBLE_PREFIX_TOKENS = 200_000;

const recordObservedPrefix = (agentId: string, prefix: number): void => {
  if (prefix <= 0 || prefix > MAX_PLAUSIBLE_PREFIX_TOKENS) return;
  const known = observedPrefixes.get(agentId) ?? 0;
  if (prefix > known) observedPrefixes.set(agentId, prefix);
};

/**
 * The prefix to budget against: what this replica has measured, else the
 * deterministic seed, else an unmeasured fallback.
 */
export const agentPrefixTokens = (agentId: string): number | undefined =>
  observedPrefixes.get(agentId) ?? seededPrefixes.get(agentId);

/**
 * Seed the meter from the tool schemas, which `buildAgentSet` can count without
 * a request.
 *
 * Taken as given, not scaled. The count already over-states a single request —
 * it includes every tool, where progressive disclosure ships a subset — and
 * that surplus stands in for the instructions, which cannot be counted before a
 * turn resolves them. Measured 2026-09-18 on the chatbot: the seed lands at
 * 33 784 against the 32 996 the running service then measured for itself.
 *
 * An earlier version doubled it, on the reasoning that instructions and schemas
 * are the same order. They are — but the seed was being computed from Zod's
 * internals rather than from the wire format, so the doubling applied to a
 * number already three times too large: the cap collapsed onto its floor and a
 * 39 252-token history was compacted on the first turn of a cold process for
 * nothing. Two compounding over-estimates is not twice as safe.
 */
export const seedAgentPrefix = (
  agentId: string,
  toolSchemaTokens: number,
): void => {
  if (toolSchemaTokens <= 0) return;
  seededPrefixes.set(agentId, toolSchemaTokens);
};

/**
 * How big the context was on the last call — the greater of what the provider
 * billed and what we measured ourselves.
 *
 * The reported number is the better one when it exists: it counts the system
 * prefix, the tool schemas, every accumulated tool result AND the loop's own
 * replayed reasoning. But a provider that reports no usage used to read as 0
 * and never trip the ceiling — a brake that fails silent, which is the worst
 * way for a brake to fail. `turn-usage.ts` already guards the COST side this
 * way (`costedSteps`); this is the same guard for tokens.
 *
 * Today no measured provider is actually silent on tokens — Scaleway, the one
 * that reports no cost, still reports usage — so this closes a hole that is
 * theoretical and would be invisible if it opened.
 */
export const lastStepInputTokens = (
  steps: readonly ContextCeilingStep[],
  modelId?: string,
): number => {
  const reported = steps.at(-1)?.usage?.inputTokens ?? 0;
  const estimate = estimates.get(steps);
  const estimated = estimate?.total ?? 0;
  if (reported === 0 && steps.length > 0 && modelId !== undefined) {
    if (!silentModels.has(modelId)) {
      silentModels.add(modelId);
      console.warn(
        `[context-ceiling] ${modelId} reports no input tokens — falling back to a local estimate (${estimated.toString()} tokens on this step). The ceiling is running on an under-count.`,
      );
    }
  }
  // The provider just priced the same request we measured, so this is the one
  // moment both numbers exist. What it bills beyond the history IS the prefix.
  if (reported > 0 && estimate?.agentId !== undefined) {
    recordObservedPrefix(estimate.agentId, reported - estimate.historyTokens);
  }
  return Math.max(reported, estimated);
};

/**
 * True once the last call's context reached `ceiling`. Exported on its own
 * because a handler has to ask the SAME question after the fact: the stop
 * condition ends the loop, and the handler then has to know WHY it ended in
 * order to resume rather than hand the user half an answer.
 */
export const contextCeilingReached = (
  steps: readonly ContextCeilingStep[],
  ceiling: number = AGENT_CONTEXT_CEILING_TOKENS,
  modelId?: string,
): boolean => lastStepInputTokens(steps, modelId) >= ceiling;

/**
 * The ceiling this model can actually honour.
 *
 * The absolute number answers "is the context still small enough to be
 * accurate and affordable". It does NOT answer "will the next call fit", and
 * on a narrow model those are different questions: 239 models were in the
 * production registry on 2026-09-17, the smallest window among them 125 952
 * tokens and 52 of them under 150 000. A flat 100 000 leaves ~26 000 tokens
 * of headroom there — less than the reserve a single large tool result plus
 * the turn's own output needs — and a future 64 000-token model would never
 * trip the ceiling at all before the provider refused the request.
 *
 * `effectiveContextLength` is the POOL minimum, never the catalogue headline:
 * a model is served by several hosts, routing picks one per request, and
 * budgeting against the largest overflows whenever the request lands on the
 * smallest. Same source `getCompactionThresholdTokens` derives from.
 */
export const resolveContextCeiling = (params: {
  effectiveContextLength: number;
  maxOutputTokens?: number | undefined;
  ceiling?: number;
}): number => {
  const room =
    params.effectiveContextLength -
    (params.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS) -
    CEILING_SAFETY_MARGIN_TOKENS;
  return Math.max(
    MIN_RESOLVED_CEILING_TOKENS,
    Math.min(params.ceiling ?? AGENT_CONTEXT_CEILING_TOKENS, room),
  );
};

/**
 * Only used before an agent has ever reported a step in this process — a
 * pessimistic stand-in for a prefix nobody has measured yet, not a belief about
 * its size. `buildAgentSet` replaces it with the counted tool schemas at build
 * time, and the first reported step replaces THAT with the real figure.
 */
const UNMEASURED_PREFIX_TOKENS = 35_000;

/**
 * When to compact, given the ceiling that ends a turn.
 *
 * The two numbers must not be the same, and making them the same was a real
 * defect. The ceiling measures the REQUEST — instructions, tool schemas and
 * history — while the compaction threshold measures the HISTORY alone. Set to
 * one value they disagree by exactly the prefix, and that gap is a trap rather
 * than slack: a turn ends at the ceiling, the next turn reloads a history that
 * compaction still calls small, and dies at step zero because the request
 * around it is not. Measured on a workflow run (2026-09-17, both caps at
 * 100 000): a turn ended at 103 671, then FIVE consecutive turns died at step 0
 * reporting 105 063 … 107 828 while compaction logged
 * `skipped reason=below_threshold tokens=65 018`. The run reached the eval's
 * 12-turn limit having spent 1.87 M tokens, ten of those turns doing nothing.
 *
 * Subtracting the prefix makes the two comparisons ask the same question — and
 * the prefix subtracted is the one MEASURED for this agent (`agentPrefixTokens`),
 * so a prompt edit or a new tool moves it without anyone editing a number.
 */
export const compactionCapForCeiling = (
  ceiling: number = AGENT_CONTEXT_CEILING_TOKENS,
  agentId?: string,
): number => {
  const prefix =
    (agentId === undefined ? undefined : agentPrefixTokens(agentId)) ??
    UNMEASURED_PREFIX_TOKENS;
  return Math.max(MIN_COMPACTION_CAP_TOKENS, ceiling - prefix);
};

/**
 * Floor under the compaction cap. Below this a summary of the history costs
 * more than the history, and the boundary ladder's own reduction invariant
 * starts rejecting every rung.
 */
const MIN_COMPACTION_CAP_TOKENS = 20_000;

/**
 * Output room assumed for an agent that declares no `maxOutputTokens`.
 * Generous on purpose — under-reserving overflows the request, over-reserving
 * only ends a turn a little early, and a turn boundary is cheap.
 */
const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000;

/**
 * Slack between the ceiling and what the window can hold: the tool schemas and
 * the system prefix that no per-step number accounts for, plus the one tool
 * result that lands after the last check.
 */
const CEILING_SAFETY_MARGIN_TOKENS = 8_000;

/**
 * Floor under the derived ceiling. A model so narrow that the arithmetic goes
 * negative still has to be able to take a turn; below this the step caps and
 * the provider's own error are the brakes, not a ceiling of zero that would
 * end every turn at step one.
 *
 * The number is a MEASUREMENT, not a preference, and the first one was wrong.
 * A turn cannot shed its instructions or its tool schemas: the chatbot's
 * resolved prompt is 15 778 tokens and its schemas 18 514
 * (`scripts/measure-system-prompt-tokens.ts`, 2026-09-17), so 34 292 tokens
 * are in the request before the first message. A ceiling under that is reached
 * at step ZERO — and a boundary cannot reduce a prefix, so the turn ends
 * having done nothing and the next one starts identical. Measured at the old
 * floor of 20 000, a workflow run took SEVEN turns of exactly one step each
 * (30 313, 31 520, 34 224, 35 016, 36 233, 37 114, 38 119 input tokens) and
 * failed without finishing its first task: the ceiling did not bound the run,
 * it consumed it.
 *
 * So the floor is that baseline plus one bounded tool result
 * (`DEFAULT_THRESHOLD_CHARS`, 32 000 chars ≈ 8 000 tokens), rounded up — the
 * cheapest turn that can still make progress. It also clamps
 * `AGENT_CONTEXT_CEILING_TOKENS`, whose own `min` of 20 000 buys an eval
 * nothing but no-op turns.
 */
const MIN_RESOLVED_CEILING_TOKENS = 44_000;

/**
 * End the turn once the context reaches the ceiling — composed into EVERY
 * agent by `buildToolLoopAgent`, so the chatbot, the workflow executor, the
 * dispatch sub-agent and the page builder are covered by one line.
 *
 * This is not a cap on the work. Ending a turn is a checkpoint: the workflow
 * orchestrator re-enters, a sub-agent resumes inside its own tool call, and a
 * chat turn continues into the same writer. What ends is the PREFIX — and a
 * turn boundary is the one edit every provider sanctions, because no signed
 * thinking block spans it (Anthropic's preserved-thinking prefix check,
 * DeepSeek's 400 on a missing `reasoning_content`, Gemini's "MUST resend all
 * thought blocks" all scope to within a tool-use turn). Editing the history
 * in place would violate all three; starting a new turn violates none.
 */
export const stopOnContextCeiling = <TTools extends ToolSet>(
  ceiling: number = AGENT_CONTEXT_CEILING_TOKENS,
  modelId?: string,
): StopCondition<TTools> => {
  return ({ steps }) => contextCeilingReached(steps, ceiling, modelId);
};
