/**
 * `buildPage` must be DISCOVERABLE, not merely registered.
 *
 * The page-builder sub-agent shipped attached to the chatbot's tool registry
 * but OUTSIDE the domain set `searchTools` is handed. The consequence had no
 * symptom anywhere: the agent could not find the tool, could not activate it
 * by name, and built every page inline with `managePage` instead — ten eval
 * turns in a row, no error, no failing assertion, pages that scored well. The
 * only way it surfaced was reading the tool trace of a run and noticing a name
 * that was never there.
 *
 * So this pins the property that outage had no signal for, and it pins it at
 * the seam that broke: the registry `searchTools` searches, not the registry
 * the agent holds.
 */

import { describe, expect, test } from "bun:test";
import { buildChatbotTools } from "../../../src/agents/chatbot/tools";
import { searchToolsWithKeywords } from "../../../src/tools/search-tools";

/**
 * Only the SHAPE of the registry is under test. The two sub-agent tools are
 * the ones that would drag in the whole agent graph, and neither takes part in
 * the index, so a minimal stand-in keeps this a unit test.
 */
const stub = {
  description: "stub",
  category: "domain" as const,
  searchHint: "",
};

const domainRegistry = () => {
  const registry = buildChatbotTools({
    dispatchAgent: stub as never,
    buildPage: {
      ...stub,
      searchHint:
        "build create page dashboard app interface view report visualise visualize custom ui mini-app screen design",
    } as never,
  });
  return Object.fromEntries(
    Object.entries(registry).filter(
      ([, t]) =>
        typeof t === "object" &&
        t !== null &&
        "category" in t &&
        t.category === "domain",
    ),
  );
};

describe("buildPage discoverability", () => {
  // Also the exact-name path: `searchTools` resolves `select:buildPage` with a
  // plain `name in domainTools`, so membership here IS that fast path working.
  test("is in the domain registry searchTools indexes", () => {
    expect(Object.keys(domainRegistry())).toContain("buildPage");
  });

  test("comes back from the words a page request is actually made of", () => {
    const domain = domainRegistry();
    for (const query of ["build a page", "dashboard", "custom interface"]) {
      expect(searchToolsWithKeywords(query, domain, 8)).toContain("buildPage");
    }
  });
});
