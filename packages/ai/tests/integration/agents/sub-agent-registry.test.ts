import { describe, expect, test } from "bun:test";
import { buildSubAgentTools } from "../../../src/agents/chatbot/tools";

/**
 * Structural invariants of the sub-agent tool registry.
 *
 * Replaces the former e2e eval case `dispatch-no-recursion`: recursion
 * safety is a REGISTRY property (`buildSubAgentTools` must never expose
 * `dispatchAgent`), so a deterministic assertion here catches a
 * regression for free — no live model turn needed.
 *
 * Imports from `chatbot/tools.ts` (env-free), same convention as
 * `chatbot-pd-integration.test.ts` — never from `chatbot/index.ts`,
 * which throws at import time without env.
 */
describe("sub-agent tool registry", () => {
  const names = Object.keys(buildSubAgentTools());

  test("excludes dispatchAgent (anti-recursion invariant)", () => {
    expect(names).not.toContain("dispatchAgent");
  });

  test("excludes searchTools (domain tools are pre-loaded)", () => {
    expect(names).not.toContain("searchTools");
  });

  test("still carries the core + domain workhorses", () => {
    // Guard against an accidental emptying of the registry — the
    // sub-agent must keep the read/search/compute toolbelt.
    for (const expected of [
      "searchKnowledge",
      "querySql",
      "read",
      "python",
      "bash",
      "listDocuments",
      "listObjects",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.length).toBeGreaterThan(10);
  });
});
