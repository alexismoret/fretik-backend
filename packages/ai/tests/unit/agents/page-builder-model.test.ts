/**
 * The page BUILDER's model must be resolvable per turn, not frozen at import.
 *
 * Until 2026-08-18 `pageBuilderSet` was a module-level const built from
 * `resolveModel("chat")`, and `buildPageTool` closed over it. Because that
 * const evaluated once, every memoized parent set — including the per-profile
 * ones `getChatbotAgentSet` builds — shared the SAME builder on the SAME model.
 * A team that picked a flagship in Settings got it for the conversation and the
 * code default for every page that conversation produced, and the eval header
 * that was supposed to gate page quality only ever repointed the parent turn.
 *
 * The outage had no symptom: no error, no failing assertion, pages that scored
 * 5-7 like always. It surfaced by reading the resolution chain, not by running
 * anything. So this pins the two properties that had no signal — the role
 * exists and is pinned, and a profile key actually changes the model — at the
 * seam that broke rather than at the object the agent holds.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { getPageBuilderSet } from "../../../src/agents/chatbot";
import { clearResolvedModelCache } from "../../../src/lib/model-registry/resolve";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import { installBoundFleet } from "../../lib/live-fleet";

// Resolution reads the live registry, so the models the bindings name have to
// exist as rows before a set can be built for them.
beforeAll(() => {
  installBoundFleet();
  clearResolvedModelCache();
});

describe("the page builder's model", () => {
  test("has its own role — the builder is not the chat binding by accident", () => {
    // The defect was invisible precisely BECAUSE the two coincided. They may
    // coincide again after an A/B, but only deliberately: `page-build` has to
    // exist as its own binding for a repoint to be expressible at all.
    expect(ROLE_BINDINGS["page-build"]).toBeDefined();
    expect(ROLE_BINDINGS["page-build"].role).toBe("page-build");
  });

  test("defaults to the `page-build` binding, not to `chat`", () => {
    // Identity, not a model field: the sets are memoized per ResolvedModel, so
    // "same set" IS "same model" and it holds without reaching into the agent.
    expect(getPageBuilderSet()).toBe(
      getPageBuilderSet(ROLE_BINDINGS["page-build"].profileKey),
    );
  });

  test("a profile key changes the builder — the A/B seam", () => {
    // The header (`X-Page-Build-Profile-Key`) is worth nothing if resolution
    // ignores it. Any profile that is NOT the current binding proves the knob
    // is wired.
    const candidate = "deepseek-v4-flash";
    expect(ROLE_BINDINGS["page-build"].profileKey).not.toBe(candidate);
    expect(getPageBuilderSet(candidate)).not.toBe(getPageBuilderSet());
  });

  test("the same profile resolves to the same instance — memoized, not rebuilt", () => {
    // Rebuilding an agent set per call would re-create every tool on every
    // page build. `memoizeAgentSets` is what keeps per-call resolution cheap.
    expect(getPageBuilderSet("gemini-3.7-flash")).toBe(
      getPageBuilderSet("gemini-3.7-flash"),
    );
    expect(getPageBuilderSet()).toBe(getPageBuilderSet());
  });
});
