/**
 * Shared case-execution core for the eval harness. Not a test file.
 *
 * Extracted from `run.ts` so BOTH the standalone runner (local JSON/MD
 * report) AND the Langfuse experiment task (`evals/langfuse/task.ts`)
 * drive the exact same pipeline — `createEphemeralConversation → seed →
 * invokeChatbot → runAssertions → cleanup → destroy` — with identical
 * ordering (custom assertions read the DB BEFORE cleanup wipes it).
 */

import { runAssertions } from "./assertions";
import {
  createEphemeralConversation,
  destroyEphemeralConversation,
} from "./conversation-lifecycle";
import { invokeChatbot } from "./http-client";
import type { Assertion, CaseResult, EvalCase, EvalSuite } from "./types";

export interface RunCaseOptions {
  /**
   * Skip `judge` assertions (no LLM call) — the PR CI tier runs
   * deterministic checks only. Defaults to false (full run).
   */
  deterministicOnly?: boolean;
  /**
   * Pin every invoke to this registry profile (`X-Model-Profile-Key`).
   * Set by the C3 gate's candidate runs; omitted → the service's
   * default `chat` binding.
   */
  modelProfileKey?: string;
  /**
   * Pin the PAGE BUILDER to this profile (`X-Page-Build-Profile-Key`). Distinct
   * from `modelProfileKey`, which only ever reached the parent turn.
   */
  pageBuildProfileKey?: string;
}

const selectAssertions = (
  assertions: Assertion[],
  opts?: RunCaseOptions,
): Assertion[] =>
  opts?.deterministicOnly
    ? assertions.filter((a) => a.type !== "judge")
    : assertions;

export const runCase = async (
  suite: EvalSuite,
  c: EvalCase,
  opts?: RunCaseOptions,
): Promise<CaseResult> => {
  // Every case runs against a fresh `ai_conversations` row so
  // sandbox-backed tools (bash, python, read) see a valid
  // `conversationId` in their runtime context. Without this they'd
  // short-circuit to NO_CONVERSATION and the agent would loop on failed
  // retries, distorting the routing signal and inflating latency.
  // Cleanup is best-effort in `finally`.
  let conversationId: string | undefined;
  try {
    conversationId = await createEphemeralConversation({
      teamId: process.env.EVAL_TEAM_ID ?? "",
      organizationId: process.env.EVAL_ORGANIZATION_ID ?? "",
      userId: process.env.EVAL_USER_ID,
      label: `${suite.name}/${c.id}`,
      prompt: c.prompt,
      fixtures: c.fixtures,
    });
  } catch (err) {
    console.warn(
      `[evals] createEphemeralConversation failed for ${c.id}; falling back to stateless:`,
      err instanceof Error ? err.message : err,
    );
  }
  const ctx = {
    conversationId: conversationId ?? "",
    teamId: process.env.EVAL_TEAM_ID ?? "",
    organizationId: process.env.EVAL_ORGANIZATION_ID ?? "",
    userId: process.env.EVAL_USER_ID,
  };
  try {
    if (c.seed && conversationId) {
      await c.seed(ctx);
    }
    const invoke = await invokeChatbot(c.prompt, conversationId, {
      modelProfileKey: opts?.modelProfileKey,
      pageBuildProfileKey: opts?.pageBuildProfileKey,
    });
    const assertions = await runAssertions(
      selectAssertions(c.assertions, opts),
      invoke,
      c.prompt,
      ctx,
    );
    const passed = assertions.every((a) => a.passed);
    return {
      caseId: c.id,
      suiteName: suite.name,
      description: c.description,
      prompt: c.prompt,
      passed,
      invoke,
      assertions,
    };
  } finally {
    if (c.cleanup && conversationId) {
      try {
        await c.cleanup(ctx);
      } catch (err) {
        console.warn(
          `[evals] case cleanup failed for ${c.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    if (conversationId) {
      await destroyEphemeralConversation(conversationId);
    }
  }
};

export const filterCasesByTag = (suite: EvalSuite, tag?: string): EvalCase[] =>
  tag ? suite.cases.filter((c) => c.tags?.includes(tag)) : suite.cases;

/** Simple promise pool — resolves when every task has been awaited. */
export const pool = async <T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor++;
      const item = items[idx];
      if (item === undefined) return;
      await fn(item);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
};
