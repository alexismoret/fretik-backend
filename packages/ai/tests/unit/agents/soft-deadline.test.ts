import type { PrepareStepFunction, ToolSet } from "ai";
import { describe, expect, test } from "bun:test";
import { withSoftDeadline } from "../../../src/agents/shared/agent-builder";

/**
 * The wall-clock wrap-up steer for sub-agents running under a dispatch
 * deadline.
 *
 * The hard deadline is an AbortSignal that cuts mid-generation — measured
 * 2026-08-23, two of three page builds died at exactly 900s with a paid,
 * half-streamed generation thrown away. This wrapper is what turns that cliff
 * into an ending: past the soft threshold the model is told once, via a
 * transient user message, to land what it has.
 */

const SOFT = { afterMs: 60_000, text: "[deadline] wrap up now" };

type StepOptions = Parameters<PrepareStepFunction<ToolSet>>[0];

/** The two fields the wrapper reads, aged so the run looks `ageMs` old. */
const optionsAged = (
  ageMs: number,
  extra: { messages?: StepOptions["messages"]; noSteps?: boolean } = {},
): StepOptions =>
  ({
    steps: extra.noSteps
      ? []
      : [{ response: { timestamp: new Date(Date.now() - ageMs) } }],
    messages: extra.messages ?? [{ role: "user", content: "build the page" }],
    stepNumber: extra.noSteps ? 0 : 1,
  }) as unknown as StepOptions;

const passthrough: PrepareStepFunction<ToolSet> = () => ({});

describe("withSoftDeadline", () => {
  test("stays silent before the threshold", async () => {
    const prepare = withSoftDeadline(passthrough, SOFT);
    const result = await prepare(optionsAged(10_000));
    expect(result?.messages).toBeUndefined();
  });

  test("appends the steer once the run is past the threshold", async () => {
    const prepare = withSoftDeadline(passthrough, SOFT);
    const result = await prepare(optionsAged(120_000));
    const last = result?.messages?.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(SOFT.text);
  });

  test("never injects twice — dedup is by exact text", async () => {
    const prepare = withSoftDeadline(passthrough, SOFT);
    const first = await prepare(optionsAged(120_000));
    const again = await prepare(
      optionsAged(180_000, { messages: first?.messages }),
    );
    // Unchanged result: the steer is already in the incoming messages.
    expect(again?.messages).toBeUndefined();
  });

  test("stays silent on step 0 — there is no anchor yet", async () => {
    const prepare = withSoftDeadline(passthrough, SOFT);
    const result = await prepare(optionsAged(0, { noSteps: true }));
    expect(result?.messages).toBeUndefined();
  });

  test("without a config it is the base prepareStep, untouched", async () => {
    const prepare = withSoftDeadline(passthrough, undefined);
    expect(prepare).toBe(passthrough);
  });
});
