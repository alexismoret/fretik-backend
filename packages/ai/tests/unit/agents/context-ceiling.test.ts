import type { StepResult, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import {
  AGENT_CONTEXT_CEILING_TOKENS,
  agentPrefixTokens,
  compactionCapForCeiling,
  contextCeilingReached,
  lastStepInputTokens,
  recordContextEstimate,
  resolveContextCeiling,
  seedAgentPrefix,
  stopOnContextCeiling,
} from "../../../src/agents/shared/context-ceiling";

/**
 * The brake the 2026-09-17 runaway did not have.
 *
 * That turn ran 50 steps from 32 452 to 200 480 input tokens; every existing
 * stop condition was correctly silent because none of them measures context.
 * These fix the two things the ceiling has to get right: it reads the LAST
 * call's prompt (not a total, not an average), and a provider that reports no
 * usage must not trip it.
 */

const steps = (inputTokens: (number | undefined)[]): StepResult<ToolSet>[] =>
  inputTokens.map((tokens) => ({
    usage: tokens === undefined ? undefined : { inputTokens: tokens },
  })) as unknown as StepResult<ToolSet>[];

describe("lastStepInputTokens", () => {
  test("reads the last call's prompt, not the sum of the turn", () => {
    expect(lastStepInputTokens(steps([90_000, 95_000, 40_000]))).toBe(40_000);
  });

  test("no steps and missing usage both read zero", () => {
    expect(lastStepInputTokens([])).toBe(0);
    expect(lastStepInputTokens(steps([undefined]))).toBe(0);
  });
});

describe("contextCeilingReached", () => {
  test("fires at the ceiling, not above it", () => {
    expect(contextCeilingReached(steps([99_999]), 100_000)).toBe(false);
    expect(contextCeilingReached(steps([100_000]), 100_000)).toBe(true);
  });

  test("the incident's curve crosses where the measurement says it should", () => {
    // Step 25 of the real turn: 100 095 input tokens. The old harness ran 25
    // more steps from there, for 3 865 445 tokens and no deliverable.
    expect(contextCeilingReached(steps([32_452]), 100_000)).toBe(false);
    expect(contextCeilingReached(steps([100_095]), 100_000)).toBe(true);
  });

  test("a silent provider with nothing measured stays under the ceiling", () => {
    // No `recordContextEstimate` ran for this array, so there is nothing to
    // fall back TO. Degrading to the step caps beats ending every turn at
    // step one — the fallback has to be measured, not assumed.
    expect(contextCeilingReached(steps([undefined]), 100_000)).toBe(false);
  });

  test("defaults to the shipped ceiling", () => {
    expect(contextCeilingReached(steps([AGENT_CONTEXT_CEILING_TOKENS]))).toBe(
      true,
    );
    expect(
      contextCeilingReached(steps([AGENT_CONTEXT_CEILING_TOKENS - 1])),
    ).toBe(false);
  });
});

describe("stopOnContextCeiling", () => {
  test("is a stop condition over the same predicate", async () => {
    const stop = stopOnContextCeiling<ToolSet>(100_000);
    expect(await stop({ steps: steps([40_000]) })).toBe(false);
    expect(await stop({ steps: steps([100_001]) })).toBe(true);
  });
});

/**
 * The half that makes the brake unable to fail silent.
 *
 * `stopWhen` is handed `{ steps }` and nothing else — no runtime context, no
 * messages (verified in `ai@7`'s `.d.ts`). `prepareStep` is handed the
 * messages AND the same `steps` array object, so the estimate travels between
 * the two hooks through that array's identity. Same mechanism as `identities`
 * in `agent-set.ts`.
 */
describe("the local estimate, for a provider that reports nothing", () => {
  // Ordinary prose, repeated — NOT one repeated character. The estimate is a
  // real token count now, and `"x".repeat(600_000)` is both unrepresentative
  // (it compresses to ~1 token per 8 characters, so it under-fills a ceiling
  // its length suggests it would blow through) and the exact shape that made
  // the encoder quadratic before it counted in slices.
  const bigMessages = [
    {
      role: "user",
      content:
        "Le rapprochement bancaire compare les écritures comptables aux relevés fournis par la banque, ligne à ligne. ".repeat(
          6_000,
        ),
    },
  ] as const;

  test("a silent provider still trips the ceiling", () => {
    const run = steps([undefined]);
    recordContextEstimate(run, "system prompt", bigMessages);
    // ~660 KB of French prose ≈ 130 000 tokens — over a 100 000 ceiling the
    // reported zero would have sailed straight through.
    expect(contextCeilingReached(run, 100_000)).toBe(true);
  });

  test("the reported number wins when it is larger", () => {
    // It should: it counts the tool schemas and the replayed reasoning, which
    // `prepareStep` never sees. The estimate is a floor, not a correction.
    const run = steps([180_000]);
    recordContextEstimate(run, "sys", [{ role: "user", content: "hi" }]);
    expect(lastStepInputTokens(run)).toBe(180_000);
  });

  test("the estimate is keyed on the array, not shared between runs", () => {
    const measured = steps([undefined]);
    const other = steps([undefined]);
    recordContextEstimate(measured, "", bigMessages);
    expect(contextCeilingReached(measured, 100_000)).toBe(true);
    expect(contextCeilingReached(other, 100_000)).toBe(false);
  });

  test("system-message instructions are counted too, not just the string form", () => {
    const run = steps([undefined]);
    // `Instructions` is a string OR an array of system messages, and both
    // reach the wire as prompt bytes.
    recordContextEstimate(
      run,
      [
        {
          role: "system",
          content:
            "Tu es un assistant de travail pour des équipes B2B. Réponds dans la langue de l'utilisateur. ".repeat(
              6_000,
            ),
        },
      ],
      [],
    );
    expect(contextCeilingReached(run, 100_000)).toBe(true);
  });
});

describe("resolveContextCeiling", () => {
  test("a wide model keeps the absolute ceiling", () => {
    expect(
      resolveContextCeiling({
        effectiveContextLength: 1_000_000,
        maxOutputTokens: 16_000,
        ceiling: 100_000,
      }),
    ).toBe(100_000);
  });

  test("the narrowest model in the registry is now HELD BELOW the default", () => {
    // 125 952 is the smallest effective window measured across the 239
    // production models (2026-09-17), and this clamp used to be inert: at a
    // default of 100 000 every registry model had room for the whole ceiling,
    // so the lowering only ever existed for a model not yet added.
    //
    // Raising the default to 180 000 on 2026-09-18 made it LOAD-BEARING for
    // the first time. 125 952 − 16 000 output − 8 000 margin = 101 952, so a
    // narrow model now runs at its own window's limit while a 1M model runs at
    // 180 000 — which is the entire reason the raise is safe to make globally
    // rather than per-model. Delete the clamp and those models start sending
    // requests their provider refuses.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 125_952,
        maxOutputTokens: 16_000,
        ceiling: AGENT_CONTEXT_CEILING_TOKENS,
      }),
    ).toBe(101_952);
  });

  test("a wide model keeps the raised default in full", () => {
    // The other half of the same claim: the clamp must not quietly lower the
    // ceiling everywhere just because it now bites somewhere.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 997_952,
        maxOutputTokens: 16_000,
        ceiling: AGENT_CONTEXT_CEILING_TOKENS,
      }),
    ).toBe(AGENT_CONTEXT_CEILING_TOKENS);
  });

  test("a narrow model is held below what its window can take", () => {
    // 200 000 − 16 000 output − 8 000 margin = 176 000. A flat 1 000 000 would
    // never fire here: the provider would refuse the request first.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 200_000,
        maxOutputTokens: 16_000,
        ceiling: 1_000_000,
      }),
    ).toBe(176_000);
  });

  test("the floor wins over the window, and that is the deliberate choice", () => {
    // 64 000 − 16 000 output − 8 000 margin = 40 000 of room, which is BELOW
    // the floor: the prompt and tool schemas alone are 34 292 tokens, so a
    // 40 000 ceiling leaves less than one bounded tool result. The two guards
    // cannot both hold, and the floor wins — a ceiling that fires before the
    // turn can do anything does not bound the run, it consumes it (measured:
    // 7 turns of one step each). The request still fits: 44 000 + 16 000 is
    // 60 000 of a 64 000 window, spending 4 000 of the 8 000 safety margin.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 64_000,
        maxOutputTokens: 16_000,
        ceiling: 100_000,
      }),
    ).toBe(44_000);
  });

  test("an absurdly narrow model still gets a usable turn", () => {
    // The arithmetic goes negative; a ceiling of zero would end every turn at
    // step one, which is worse than no ceiling at all. Here the provider's own
    // error is the brake, as the floor's docblock says.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 8_000,
        maxOutputTokens: 16_000,
        ceiling: 100_000,
      }),
    ).toBe(44_000);
  });

  test("the eval knob cannot be turned below the floor", () => {
    // `AGENT_CONTEXT_CEILING_TOKENS` accepts 20 000, and an eval that set it
    // there got seven no-op turns rather than a cheap measurement. The knob
    // still lowers the COMPACTION cap; the ceiling is clamped.
    expect(
      resolveContextCeiling({
        effectiveContextLength: 1_000_000,
        maxOutputTokens: 16_000,
        ceiling: 20_000,
      }),
    ).toBe(44_000);
  });

  test("an agent with no declared output cap reserves a default", () => {
    expect(
      resolveContextCeiling({
        effectiveContextLength: 200_000,
        ceiling: 1_000_000,
      }),
    ).toBe(176_000);
  });
});

/**
 * The gap between "the request is too big" and "the history is too big".
 *
 * These two numbers were once the same constant, and the measured consequence
 * was ten wasted turns in a single run: the turn ended at the ceiling, the next
 * one reloaded a history compaction still called small, and died at step zero
 * because the prefix around it pushed the request back over. The invariant is
 * not a magic number — it is that the cap must be at least one prefix below
 * whatever ceiling it is paired with.
 */
describe("compactionCapForCeiling", () => {
  test("sits a full prefix below the ceiling it is paired with", () => {
    const agent = "cap-paired";
    seedAgentPrefix(agent, 30_000);
    expect(compactionCapForCeiling(100_000, agent)).toBe(70_000);
  });

  test("would have fired on the turn that was skipped", () => {
    // The measured run logged `skipped reason=below_threshold tokens=65018`
    // and then died at step 0 with a request of 105 063. One token above the
    // cap is the whole point: that turn had to compact.
    const agent = "cap-skipped";
    seedAgentPrefix(agent, 35_000); // the prefix that run actually carried
    expect(65_018).toBeGreaterThan(compactionCapForCeiling(100_000, agent));
  });

  test("the seed is taken as given, never scaled", () => {
    // It was doubled once, on top of a count that was itself three times too
    // large, and the cap collapsed onto its floor: a 39 252-token history was
    // compacted on the first turn of a cold process for nothing.
    const agent = "cap-unscaled";
    seedAgentPrefix(agent, 33_784);
    expect(agentPrefixTokens(agent)).toBe(33_784);
  });

  test("a turn that compacts leaves room for the prefix AND a step", () => {
    // The cap plus the prefix must land under the ceiling, or a history that
    // just passed the check still produces a request that trips it.
    const agent = "cap-room";
    seedAgentPrefix(agent, 35_000);
    const prefix = agentPrefixTokens(agent) ?? 0;
    expect(
      compactionCapForCeiling(100_000, agent) + prefix,
    ).toBeLessThanOrEqual(100_000);
  });

  test("an agent nobody has measured still gets a cap below the ceiling", () => {
    // The cold path: no seed, no reported step. It must not return the ceiling
    // itself, which is the equality that caused the wasted turns.
    expect(compactionCapForCeiling(100_000, "never-seen")).toBeLessThan(
      100_000,
    );
    expect(compactionCapForCeiling(100_000)).toBeLessThan(100_000);
  });

  test("never collapses to a cap smaller than its own summary", () => {
    expect(compactionCapForCeiling(44_000)).toBe(20_000);
  });
});
