/**
 * The core tools must form a PREFIX of the registry, with no domain tool
 * among them.
 *
 * Key order in this object is not cosmetic: it is the order the tools reach
 * the wire. `activeTools` cannot reorder anything — the SDK filters by the
 * static registry (`filterActiveTools`, ai@7:
 * `Object.entries(tools).filter(([name]) => activeTools.includes(name))`) — so
 * whatever Progressive Disclosure activates is spliced into THIS sequence.
 *
 * `dispatchAgent` is the tool that made that matter. It is `category: "core"`,
 * therefore active on every step, but it was registered after the domain set,
 * so it sat behind every domain tool the model activated and moved position on
 * each activation — dragging the end of the cached prefix with it. Measured in
 * production on 2026-09-21: one 31-step turn served five steps with an input
 * cache of exactly zero.
 *
 * The invariant that prevents the next one is stronger than "dispatchAgent is
 * early": every `core` tool comes before every `domain` tool. A core tool is
 * always active, so any core tool placed late has the same defect.
 */

import { describe, expect, test } from "bun:test";
import { buildChatbotTools } from "../../../src/agents/chatbot/tools";

/** The two sub-agent tools would drag in the whole agent graph; neither's
 * behaviour is under test here, only its position. */
const stub = {
  description: "stub",
  category: "domain" as const,
  searchHint: "",
};

const registry = () =>
  buildChatbotTools({
    dispatchAgent: { ...stub, category: "core" as const } as never,
    buildPage: stub as never,
  });

describe("chatbot tool registry order", () => {
  test("every core tool precedes every domain tool", () => {
    const entries = Object.entries(registry());
    const categories = entries.map(([name, tool]) => ({
      name,
      category: (tool as { category: string }).category,
    }));

    const lastCore = categories.reduce(
      (acc, t, i) => (t.category === "core" ? i : acc),
      -1,
    );
    const firstDomain = categories.findIndex((t) => t.category === "domain");

    expect(firstDomain).toBeGreaterThan(-1);
    expect(lastCore).toBeGreaterThan(-1);
    // The whole claim, in one comparison: the core block closes before the
    // domain block opens.
    expect(lastCore).toBeLessThan(firstDomain);
  });

  test("dispatchAgent is inside the core block, not after the domain set", () => {
    const names = Object.keys(registry());
    const entries = Object.entries(registry());
    const firstDomain = entries.findIndex(
      ([, tool]) => (tool as { category: string }).category === "domain",
    );

    expect(names).toContain("dispatchAgent");
    expect(names.indexOf("dispatchAgent")).toBeLessThan(firstDomain);
  });
});
