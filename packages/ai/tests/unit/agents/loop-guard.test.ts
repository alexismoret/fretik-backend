import type { PrepareStepFunction, StepResult, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import { withLoopGuard } from "../../../src/agents/shared/agent-builder";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { StepCallBudget } from "../../../src/agents/shared/step-call-budget";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

/**
 * The three stages of the loop guard, and what the user gets out of each.
 *
 * Stage 2 is the one 2026-09-14 needed. That turn ran 26 tool calls in four
 * minutes with the model narrating its own loop, and ended when the user
 * pressed Stop — so the product's answer to a runaway was 26 tool cards and
 * no words. Withdrawing the tools leaves the model nothing to do but explain,
 * which is the outcome a person can act on.
 */

type StepOptions = Parameters<PrepareStepFunction<ToolSet>>[0];

const ctx = () =>
  wrapRuntimeContext({
    organizationId: "org-1",
    teamId: "team-1",
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  });

const failing = (n: number): StepResult<ToolSet>[] =>
  Array.from(
    { length: n },
    () =>
      ({
        toolResults: [
          {
            toolName: "managePage",
            input: { action: "update" },
            output: { error: "update needs a pageId", code: "INVALID_ARGS" },
          },
        ],
      }) as unknown as StepResult<ToolSet>,
  );

const options = (steps: StepResult<ToolSet>[]): StepOptions =>
  ({
    steps,
    stepNumber: steps.length,
    messages: [{ role: "user", content: "widen the page" }],
    runtimeContext: ctx(),
  }) as unknown as StepOptions;

/** A base hook that returns a tool list, so a withdrawal is visible. */
const base: PrepareStepFunction<ToolSet> = () => ({
  activeTools: ["managePage", "read"],
  toolsContext: {},
});

const lastMessage = (
  result: Awaited<ReturnType<PrepareStepFunction<ToolSet>>>,
) => result?.messages?.at(-1);

describe("withLoopGuard", () => {
  test("says nothing while the model is still making progress", async () => {
    const result = await withLoopGuard(base)(options(failing(1)));
    expect(result?.messages).toBeUndefined();
    expect(result?.activeTools).toEqual(["managePage", "read"]);
  });

  test("steers on the second malformed call, keeping every tool", async () => {
    const result = await withLoopGuard(base)(options(failing(2)));
    expect(lastMessage(result)?.content).toContain("[loop-guard]");
    expect(lastMessage(result)?.content).toContain("managePage");
    expect(result?.activeTools).toEqual(["managePage", "read"]);
  });

  test("never injects the same steer twice", async () => {
    // Dedup is "emit no override", not "emit the same list again": the SDK
    // carries a message override forward for the rest of the turn, so a
    // second copy would be a second copy in the history.
    const guarded = withLoopGuard(base);
    const first = await guarded(options(failing(2)));
    expect(first?.messages).toBeDefined();
    const second = await guarded({
      ...options(failing(3)),
      messages: first?.messages ?? [],
    });
    expect(second?.messages).toBeUndefined();
  });

  test("withdraws every tool at the disarm threshold and asks for an explanation", async () => {
    const result = await withLoopGuard(base)(options(failing(6)));
    expect(result?.activeTools).toEqual([]);
    expect(lastMessage(result)?.content).toContain("tools are now withdrawn");
    // The base hook's other decisions survive — only the tool list is taken.
    expect(result?.toolsContext).toEqual({});
  });

  test("keeps the tools withdrawn on every later step", async () => {
    const guarded = withLoopGuard(base);
    const first = await guarded(options(failing(6)));
    const next = await guarded({
      ...options(failing(7)),
      messages: first?.messages ?? [],
    });
    // The withdrawal is per-step and must be re-asserted; the message is
    // carried by the SDK and must not.
    expect(next?.activeTools).toEqual([]);
    expect(next?.messages).toBeUndefined();
  });

  test("withdraws the tools after ONE step that flooded", async () => {
    // The shape production actually produces, and the one the `failing(n)`
    // fixtures never had: a single step whose 300 calls were all refused by
    // `StepCallBudget`. Measured 2026-09-20 — 273 refusals in one step, then
    // 172 more in the NEXT one, which is the withdrawal failing to bite.
    const flooded = [
      {
        toolResults: Array.from({ length: 300 }, () => ({
          toolName: "manageSync",
          input: { action: "preview" },
          output: { error: "refused", code: "STEP_CALL_CAP" },
        })),
      } as unknown as StepResult<ToolSet>,
    ];
    const result = await withLoopGuard(base)(options(flooded));
    expect(result?.activeTools).toEqual([]);
  });

  test("opens the step's tool-call budget with the step number", async () => {
    const budget = new StepCallBudget(2);
    const runtimeContext = wrapRuntimeContext({
      organizationId: "org-1",
      teamId: "team-1",
      modelProfile: getProfileForRole("chat"),
      dynamicToolManager: new DynamicToolManager(),
      stepCallBudget: budget,
    });
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    await withLoopGuard(base)({
      ...options([]),
      stepNumber: 1,
      runtimeContext,
    });
    expect(budget.tryAcquire()).toBe(true);
  });
});

describe("StepCallBudget", () => {
  test("refuses past the cap and resets on a new step", () => {
    const budget = new StepCallBudget(2);
    budget.beginStep(0);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(true);
    expect(budget.tryAcquire()).toBe(false);
    budget.beginStep(1);
    expect(budget.tryAcquire()).toBe(true);
  });

  test("beginStep is idempotent — a second call mid-step grants nothing", () => {
    const budget = new StepCallBudget(1);
    budget.beginStep(3);
    expect(budget.tryAcquire()).toBe(true);
    budget.beginStep(3);
    expect(budget.tryAcquire()).toBe(false);
  });
});
