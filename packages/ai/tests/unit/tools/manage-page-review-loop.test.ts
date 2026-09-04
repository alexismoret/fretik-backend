import { badRequest } from "@fretik/shared/lib/errors";
import "@hono/zod-openapi";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { mockModule } from "../../lib/mock-module";

/**
 * The review loop's ECONOMICS, which prose alone failed to enforce.
 *
 * Measured on `pages-final-v2` (2026-08-23): the budget said three reviews and
 * five ran (builder and parent counted under different keys); identical bytes
 * were re-scored 6.8 → 7.8 (critic variance, both rounds paid); a rate-limited
 * critic consumed a round in 2s; and every compile-refused write was re-emitted
 * whole (~16k tokens, twice per fix round). Each test here pins the mechanism
 * that closes one of those holes.
 */

const PAGE_ID = "01a00000-0000-7000-8000-00000000000a";
const SOURCE = [
  "<template>",
  '  <div class="p-6"><h1>Board</h1><p>lane content here</p></div>',
  "</template>",
  "<script setup>",
  "const lanes = [];",
  "</script>",
].join("\n");

const LANE = ["<template>", "  <p>lane</p>", "</template>"].join("\n");

/** Fresh scope per test so the real Redis store never bleeds state across. */
let scope = "";
let pageId = PAGE_ID;
const freshIds = () => {
  const n = crypto.randomUUID();
  scope = `trace-${n}`;
  pageId = n;
};

// --- seams -----------------------------------------------------------------
// Captured BEFORE the fakes go in, and restored in `afterAll`.
const realRenderPage =
  await import("@fretik/shared/services/pages/render/render-page");
const realUpdate = await import("@fretik/shared/services/pages/update");
const realCreate = await import("@fretik/shared/services/pages/create");
const realRetrieve = await import("@fretik/shared/services/pages/retrieve");
const realVersions = await import("@fretik/shared/services/pages/versions");
const realRestore = await import("@fretik/shared/services/pages/restore");
const realDryRun = await import("@fretik/shared/services/pages/dry-run");
const realMemberRole =
  await import("@fretik/shared/services/organization/member-role");

// A render the REAL gate passes — mocking the gate instead would replace it
// for every other test file (Bun's module mocks are process-wide).
const cleanRender = {
  mounted: true,
  settled: true,
  shots: [],
  interactions: [
    {
      target: 'button "Filtrer"',
      kind: "button",
      domChanged: true,
      overlayOpened: false,
      overlayTextLength: 0,
      overlayContentCount: 0,
    },
  ],
  layout: {
    desktop: { horizontalOverflow: false, clipped: 0, textLength: 2_400 },
    mobile: { horizontalOverflow: false, clipped: 0, textLength: 2_100 },
    "empty-state": { horizontalOverflow: false, clipped: 0, textLength: 420 },
  },
  consoleErrors: [],
  pageErrors: [],
  opsRuns: ["update_status"],
};

const renderCalls: unknown[] = [];
await mockModule("@fretik/shared/services/pages/render/render-page", {
  renderPage: async (args: unknown) => {
    renderCalls.push(args);
    return cleanRender;
  },
});

// Only the model call is faked; SHIP_SCORE and the rest of the module stay
// real, so restoring it after this file leaves nothing behind.
const realEvaluate = await import("../../../src/services/page-review/evaluate");
let critiqueResult: Record<string, unknown> = { ok: false, reason: "unset" };
// Counted, not just stubbed: the last look is defined by which half of the
// review it runs, so "the critic was not called" has to be assertable.
let critiqueCalls = 0;
await mockModule("../../../src/services/page-review/evaluate", {
  evaluatePageDesign: async () => {
    critiqueCalls += 1;
    return critiqueResult;
  },
});

const updateCalls: { input: Record<string, unknown> }[] = [];
let updateThrows: HTTPException | null = null;
await mockModule("@fretik/shared/services/pages/update", {
  updatePage: async (args: { input: Record<string, unknown> }) => {
    updateCalls.push(args);
    if (updateThrows) throw updateThrows;
    return {
      page: {
        id: pageId,
        userId: null,
        definition: {
          code: {
            source:
              (args.input["definition"] as { code?: { source?: string } })?.code
                ?.source ?? SOURCE,
          },
        },
      },
      warnings: [],
    };
  },
});

const createCalls: { input: { definition: { code: { source: string } } } }[] =
  [];
let createThrows: HTTPException | null = null;
await mockModule("@fretik/shared/services/pages/create", {
  createPage: async (args: {
    input: { definition: { code: { source: string } } };
  }) => {
    createCalls.push(args);
    if (createThrows) throw createThrows;
    return {
      page: { id: pageId, userId: null, definition: args.input.definition },
      warnings: [],
    };
  },
});

await mockModule("@fretik/shared/services/pages/retrieve", {
  getPage: async () => ({
    id: pageId,
    name: "Board",
    description: "",
    userId: null,
    definition: {
      brief: undefined,
      datasets: [],
      // Present because the real schema always fills it: the gate reads it to
      // decide whether "no operation ran" is a defect or the design.
      operations: [],
      code: {
        source: SOURCE,
        // A project, not a lone SFC: the edit path patches the file an edit
        // names, and a single-file fixture could not tell the two apart.
        files: { "components/Lane.vue": LANE },
        compiled: { js: "x", css: "" },
      },
    },
    runtimeErrors: [],
  }),
  listPages: async () => [],
});

await mockModule("@fretik/shared/services/pages/versions", {
  writePageVersion: async () => ({ versionNumber: 1 }),
  trimPageVersions: async () => undefined,
});

await mockModule("@fretik/shared/services/pages/restore", {
  restorePageVersion: async () => undefined,
});

await mockModule("@fretik/shared/services/pages/dry-run", {
  dryRunPage: async () => ({ samples: {}, warnings: [], refusals: [] }),
});

await mockModule("@fretik/shared/services/organization/member-role", {
  isOrgAdmin: async () => false,
});

// `mock.module` is process-wide and `mock.restore()` does not undo it: every
// module faked above is put back so the files that run after this one see the
// real thing.
afterAll(() => {
  void mock.module(
    "../../../src/services/page-review/evaluate",
    () => realEvaluate,
  );
  void mock.module(
    "@fretik/shared/services/pages/render/render-page",
    () => realRenderPage,
  );
  void mock.module("@fretik/shared/services/pages/update", () => realUpdate);
  void mock.module("@fretik/shared/services/pages/create", () => realCreate);
  void mock.module(
    "@fretik/shared/services/pages/retrieve",
    () => realRetrieve,
  );
  void mock.module(
    "@fretik/shared/services/pages/versions",
    () => realVersions,
  );
  void mock.module("@fretik/shared/services/pages/restore", () => realRestore);
  void mock.module("@fretik/shared/services/pages/dry-run", () => realDryRun);
  void mock.module(
    "@fretik/shared/services/organization/member-role",
    () => realMemberRole,
  );
});

const { createManagePageTool } = await import("../../../src/tools/manage-page");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");
const { getProfileForRole } =
  await import("../../../src/lib/model-registry/resolve");
const {
  MAX_PAGE_REVIEWS,
  bumpPageReviewIteration,
  hashPageCode,
  readPageReviewIterations,
  readPageReviewVerdict,
  recordPageReviewVerdict,
} = await import("../../../src/services/page-review/page-session-store");

const execManagePage = async (
  input: { action: "review" | "update" | "get" } & Record<string, unknown>,
  overrides: { traceId?: string } = {},
): Promise<Record<string, unknown>> => {
  const tool = createManagePageTool();
  if (typeof tool.execute !== "function") {
    throw new Error("managePage missing execute");
  }
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    userId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    traceId: overrides.traceId ?? scope,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  const result = await tool.execute(
    { pageId, ...input },
    { toolCallId: "tc-1", messages: [], context: wrapRuntimeContext(ctx) },
  );
  if (typeof result !== "object" || result === null) {
    throw new Error("managePage returned non-object");
  }
  return result as Record<string, unknown>;
};

beforeEach(() => {
  freshIds();
  renderCalls.length = 0;
  updateCalls.length = 0;
  createCalls.length = 0;
  updateThrows = null;
  createThrows = null;
  critiqueResult = { ok: false, reason: "unset" };
  critiqueCalls = 0;
});

const compileRefusal = () =>
  new HTTPException(400, {
    message: JSON.stringify(
      badRequest("Page code failed to compile — line 7: unexpected token"),
    ),
  });

const spendBudget = async (): Promise<void> => {
  for (let index = 0; index < MAX_PAGE_REVIEWS; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- the counter is the subject
    await bumpPageReviewIteration(scope, pageId);
  }
};

describe("review budget — hard, shared, checked before the render", () => {
  /**
   * The budget stops REVISION, never VERIFICATION.
   *
   * Reaching the cap means the page changed since its last verdict — identical
   * bytes are answered by the cache before the counter is even read — so
   * refusing outright hands over code nobody looked at. That is what happened
   * on 2026-09-04: a build repaired what a review had found, had nothing left
   * to look at the repair with, and shipped saying it had not been re-reviewed.
   */
  test("a spent budget still buys one look, and it skips the critic", async () => {
    await spendBudget();
    const result = await execManagePage({ action: "review" });
    expect(result["review"]).toBeUndefined();
    expect(result["verdict"]).toBe("ship");
    expect(result["gate"]).toBe("pass");
    // The cheap half runs...
    expect(renderCalls).toHaveLength(1);
    // ...and the half the budget was drawn around does not.
    expect(critiqueCalls).toBe(0);
  });

  test("past the last look it refuses without opening a browser", async () => {
    await spendBudget();
    await bumpPageReviewIteration(scope, pageId);
    const result = await execManagePage({ action: "review" });
    expect(result["review"]).toBe("refused");
    expect(renderCalls).toHaveLength(0);
  });

  test("the builder's `.page` trace suffix counts in the parent's scope", async () => {
    await spendBudget();
    await bumpPageReviewIteration(scope, pageId);
    const result = await execManagePage(
      { action: "review" },
      { traceId: `${scope}.page` },
    );
    expect(result["review"]).toBe("refused");
  });

  /**
   * The budget counts RENDERS since the loop became gate-first, so a critic
   * that fell over still costs the browser it used — and nothing more. What it
   * must not do is leave a verdict behind: with none recorded, the next review
   * renders and critiques again instead of returning "unverified" for ever.
   */
  test("a failed critique costs its render and pins no verdict", async () => {
    critiqueResult = { ok: false, reason: "upstream rate-limited" };
    const result = await execManagePage({ action: "review" });
    expect(result["verdict"]).toBe("unverified");
    expect(String(result["next"])).toContain("critic was unavailable");
    expect(await readPageReviewIterations(scope, pageId)).toBe(1);
    expect(await readPageReviewVerdict(scope, pageId)).toBe(null);
  });

  test("a scored ship ends the loop and pins the verdict to the bytes", async () => {
    critiqueResult = {
      ok: true,
      critique: {
        score: 8.2,
        scores: { design: 8, functionality: 8, craft: 8, originality: 9 },
        summary: "solid",
        findings: [],
        elevations: ["a filter"],
        model: "test/critic",
      },
    };
    const result = await execManagePage({ action: "review" });
    expect(result["verdict"]).toBe("ship");
    expect(String(result["next"])).toContain("Do NOT edit or review again");
    const verdict = await readPageReviewVerdict(scope, pageId);
    expect(verdict?.shipped).toBe(true);
    expect(verdict?.sourceHash).toBe(
      hashPageCode({ source: SOURCE, files: { "components/Lane.vue": LANE } }),
    );
  });

  test("an unchanged page returns its standing verdict — no render, no round", async () => {
    await recordPageReviewVerdict(scope, pageId, {
      sourceHash: hashPageCode({
        source: SOURCE,
        files: { "components/Lane.vue": LANE },
      }),
      shipped: true,
      round: 1,
      result: { verdict: "ship", score: 8 },
    });
    const result = await execManagePage({ action: "review" });
    expect(result["cached"]).toBe(true);
    expect(String(result["next"])).toContain("verdict stands");
    expect(renderCalls).toHaveLength(0);
    expect(await readPageReviewIterations(scope, pageId)).toBe(0);
  });
});

/**
 * An update has to carry a change. Measured in production (Langfuse
 * `01a0469c…`): `update { pageId, definition: {} }` was accepted, wrote a
 * version identical to the one before it and reported success — so the agent
 * believed a fix had landed and reviewed a page nothing had touched.
 */
/**
 * `get` prints ONE file, and says what the others are.
 *
 * A page is a project now, and the parent's edits anchor inside one file. The
 * old shape returned `definition.code.source` — which, on a project, is the
 * entry file wearing the name of the whole page: every component was invisible
 * and an edit against one of them could only miss.
 */
describe("get — a project, one file at a time", () => {
  test("names every file, and returns the entry by default", async () => {
    const result = await execManagePage({ action: "get" });

    expect(result["file"]).toBe("Page.vue");
    expect(result["source"]).toBe(SOURCE);
    const manifest = String(result["project"]);
    expect(manifest).toContain("Page.vue");
    expect(manifest).toContain("components/Lane.vue");
  });

  test("returns the file that was asked for", async () => {
    const result = await execManagePage({
      action: "get",
      file: "components/Lane.vue",
    });

    expect(result["file"]).toBe("components/Lane.vue");
    expect(result["source"]).toBe(LANE);
  });

  test("refuses a file the page does not have, naming the ones it does", async () => {
    const result = await execManagePage({
      action: "get",
      file: "components/Nope.vue",
    });

    expect(result["code"]).toBe("INVALID_ARGS");
    // The recovery is in the answer: no second call to discover the paths.
    expect(String(result["hint"])).toContain("components/Lane.vue");
  });
});

describe("update — a call that changes nothing is refused", () => {
  test("an empty definition writes no version", async () => {
    const result = await execManagePage({ action: "update", definition: {} });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["error"])).toContain("nothing to change");
    expect(updateCalls).toHaveLength(0);
  });

  test("no sections at all is the same refusal", async () => {
    const result = await execManagePage({ action: "update" });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(updateCalls).toHaveLength(0);
  });

  test("metadata alone is a real change and still lands", async () => {
    await execManagePage({ action: "update", name: "Board v2" });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.input["name"]).toBe("Board v2");
  });
});

/**
 * What the parent may do to a page it did not write: patch a file by name, and
 * be told plainly when a patch does not land. Authoring — and the working copy
 * that makes a refused build cheap — belongs to the builder's `page*` tools.
 */
describe("update — edits, per file", () => {
  test("an edit that names a file patches THAT file", async () => {
    const result = await execManagePage({
      action: "update",
      edits: [
        {
          file: "components/Lane.vue",
          oldString: "<p>lane</p>",
          newString: "<p>lane!</p>",
        },
      ],
    });
    expect(result["code"]).toBeUndefined();
    const sent = updateCalls.at(-1)?.input["definition"] as {
      code: { source: string; files: Record<string, string> };
    };
    // The entry is untouched and the component carries the change.
    expect(sent.code.source).toBe(SOURCE);
    expect(sent.code.files["components/Lane.vue"]).toContain("<p>lane!</p>");
  });

  test("an edit naming a file the page does not have says which it has", async () => {
    const result = await execManagePage({
      action: "update",
      edits: [{ file: "components/Ghost.vue", oldString: "a", newString: "b" }],
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["error"])).toContain("components/Lane.vue");
    expect(updateCalls).toHaveLength(0);
  });

  test("a compile refusal names the edits that did NOT land, and saves nothing", async () => {
    // Partial application: one anchor lands, one has drifted, and the result
    // does not compile. The miss used to be computed and then dropped on this
    // path — reported only when the write SUCCEEDED — so an agent whose repair
    // edit had silently missed read the same error again and concluded the
    // tool was ignoring it.
    updateThrows = compileRefusal();
    const result = await execManagePage({
      action: "update",
      edits: [
        { oldString: "const lanes = [];", newString: "const lanes = [1];" },
        { oldString: "text that this page does not contain", newString: "x" },
      ],
    });
    expect(result["code"]).toBe("COMPILE_FAILED");
    expect(String(result["hint"])).toContain("did NOT apply");
    expect(String(result["hint"])).toContain("untouched");
  });

  /**
   * Authoring is the builder's, and the enum is what enforces it: a
   * `definition` here is a whole-file write under an edit's name.
   */
  test("a definition is refused, whatever it carries", async () => {
    const result = await execManagePage({
      action: "update",
      definition: { code: { source: "<template><p>tiny</p></template>" } },
    });
    expect(result["code"]).toBe("PAGE_REQUIRES_BUILDER");
    expect(updateCalls).toHaveLength(0);
  });
});
