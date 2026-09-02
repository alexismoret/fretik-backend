import { describe, expect, test } from "bun:test";
import {
  buildRecallRecentTail,
  runUnifiedRecall,
} from "../../../src/services/recall/recall";

/**
 * Unit tests for the deterministic surface of the unified recall
 * service (P5 — evolution of Active Memory):
 *
 *   - `buildRecallRecentTail` is a pure helper — no DB / LLM
 *     dependencies, so we cover its truncation + role-filtering
 *     behaviour exhaustively.
 *
 *   - `runUnifiedRecall` triggers the gather arms + the judge LLM
 *     call when invoked on a non-trivial message. We can't exercise
 *     that path in a unit test without standing up the whole stack,
 *     so the only `runUnifiedRecall` cases here check the
 *     `isTrivialMessage` SKIP path: it MUST return `null` without
 *     touching any I/O, satisfying the "recall must never block a
 *     turn" contract for messages that don't merit recall.
 *
 * The end-to-end behaviour (judge picks the right candidate, NONE
 * verdict, attachments-as-signal, etc.) is covered by the
 * `dispatch-agent` + `auto-memory` eval suites, not here.
 *
 * This suite tests pure helpers plus an early-return path that never
 * touches I/O, so it belongs here. It spent a while under
 * `tests/integration/` for a reason that no longer exists: the SUT's
 * import chain reaches `@fretik/shared/db`, which used to APPLY
 * MIGRATIONS at module load, so merely loading the subject demanded a
 * live Postgres. Importing the database is inert now — it hands back a
 * lazy handle and opens nothing.
 */

const SCOPE = {
  teamId: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  userId: "33333333-3333-3333-3333-333333333333",
  agentType: "chatbot",
};

describe("runUnifiedRecall — skip path (trivial messages)", () => {
  test("returns null on a short ack with no attachments ('ok')", async () => {
    const result = await runUnifiedRecall({
      userMessage: "ok",
      attachedFiles: [],
      recentTail: "",
      ...SCOPE,
    });
    expect(result).toBeNull();
  });

  test("returns null on French acknowledgements ('merci')", async () => {
    const result = await runUnifiedRecall({
      userMessage: "merci",
      attachedFiles: [],
      recentTail: "",
      ...SCOPE,
    });
    expect(result).toBeNull();
  });

  test("returns null on emoji-only acknowledgements ('👍')", async () => {
    const result = await runUnifiedRecall({
      userMessage: "👍",
      attachedFiles: [],
      recentTail: "",
      ...SCOPE,
    });
    expect(result).toBeNull();
  });

  // Note: the "does NOT skip when files are attached" branch is
  // covered by the `dispatch-agent` + `auto-memory` eval suites
  // (live stack). Unit-testing it here would require firing the
  // real gather + judge LLM path (since the function falls
  // through after the trivial check), which would either timeout
  // the test or pull DB + OpenRouter into the unit harness. The
  // skip cases above are sufficient to lock the deterministic
  // branch contract.
});

describe("buildRecallRecentTail", () => {
  test("returns empty string when message history is empty", () => {
    expect(buildRecallRecentTail([])).toBe("");
  });

  test("keeps only the last 2 user turns + last 1 assistant turn", () => {
    const tail = buildRecallRecentTail([
      { role: "user", text: "very old user turn" },
      { role: "assistant", text: "very old assistant turn" },
      { role: "user", text: "older user turn" },
      { role: "assistant", text: "older assistant turn" },
      { role: "user", text: "previous user turn" },
      { role: "assistant", text: "latest assistant turn" },
    ]);
    // Latest assistant + previous 2 user turns ARE present.
    expect(tail).toContain("latest assistant turn");
    expect(tail).toContain("previous user turn");
    expect(tail).toContain("older user turn");
    // Older / very-old assistant turn is dropped (only 1 assistant
    // is kept).
    expect(tail).not.toContain("older assistant turn");
    expect(tail).not.toContain("very old assistant turn");
    // Very-old user turn is dropped (only 2 user turns are kept).
    expect(tail).not.toContain("very old user turn");
  });

  test("ignores system messages", () => {
    const tail = buildRecallRecentTail([
      { role: "system", text: "system bootstrap noise" },
      { role: "user", text: "real user turn" },
    ]);
    expect(tail).toContain("real user turn");
    expect(tail).not.toContain("system bootstrap noise");
  });

  test("truncates each user turn to ~220 chars and assistant turn to ~180 chars", () => {
    const longUserText = "u".repeat(500);
    const longAssistantText = "a".repeat(500);
    const tail = buildRecallRecentTail([
      { role: "user", text: longUserText },
      { role: "assistant", text: longAssistantText },
    ]);
    // The user's 220-char cap is enforced.
    const userMatch = /User: (u+)/.exec(tail);
    expect(userMatch).not.toBeNull();
    expect((userMatch?.[1] ?? "").length).toBeLessThanOrEqual(220);
    // The assistant's 180-char cap is enforced.
    const assistantMatch = /Assistant: (a+)/.exec(tail);
    expect(assistantMatch).not.toBeNull();
    expect((assistantMatch?.[1] ?? "").length).toBeLessThanOrEqual(180);
  });

  test("global tail length is bounded (~600 chars)", () => {
    // Push the per-turn caps to the limit and verify the overall
    // tail still respects the global hard cap. OpenClaw mirrors
    // this envelope to keep judge-prompt latency bounded.
    const tail = buildRecallRecentTail([
      { role: "user", text: "u".repeat(220) },
      { role: "assistant", text: "a".repeat(180) },
      { role: "user", text: "u".repeat(220) },
    ]);
    expect(tail.length).toBeLessThanOrEqual(600);
  });
});
