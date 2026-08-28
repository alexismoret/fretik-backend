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
await mockModule("../../../src/services/page-review/evaluate", {
  evaluatePageDesign: async () => critiqueResult,
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
      code: { source: SOURCE, compiled: { js: "x", css: "" } },
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
  dryRunPage: async () => ({ samples: {}, warnings: [] }),
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
  bumpPageReviewIteration,
  hashPageSource,
  readPageDraft,
  readPageReviewIterations,
  readPageReviewVerdict,
  recordPageReviewVerdict,
} = await import("../../../src/services/page-review/page-session-store");

const execManagePage = async (
  input: { action: "review" | "update" | "create" | "get" } & Record<
    string,
    unknown
  >,
  overrides: { traceId?: string } = {},
): Promise<Record<string, unknown>> => {
  const tool = createManagePageTool({ authoring: true });
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
});

const compileRefusal = () =>
  new HTTPException(400, {
    message: JSON.stringify(
      badRequest("Page code failed to compile — line 7: unexpected token"),
    ),
  });

describe("review budget — hard, shared, checked before the render", () => {
  test("a spent budget refuses without opening a browser", async () => {
    await bumpPageReviewIteration(scope, pageId);
    await bumpPageReviewIteration(scope, pageId);
    await bumpPageReviewIteration(scope, pageId);
    const result = await execManagePage({ action: "review" });
    expect(result["review"]).toBe("refused");
    expect(renderCalls).toHaveLength(0);
  });

  test("the builder's `.page` trace suffix counts in the parent's scope", async () => {
    await bumpPageReviewIteration(scope, pageId);
    await bumpPageReviewIteration(scope, pageId);
    await bumpPageReviewIteration(scope, pageId);
    const result = await execManagePage(
      { action: "review" },
      { traceId: `${scope}.page` },
    );
    expect(result["review"]).toBe("refused");
  });

  test("a failed critique consumes NO round", async () => {
    critiqueResult = { ok: false, reason: "upstream rate-limited" };
    const result = await execManagePage({ action: "review" });
    expect(result["verdict"]).toBe("unverified");
    expect(String(result["next"])).toContain("did not consume");
    expect(await readPageReviewIterations(scope, pageId)).toBe(0);
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
    expect(verdict?.sourceHash).toBe(hashPageSource(SOURCE));
  });

  test("an unchanged page returns its standing verdict — no render, no round", async () => {
    await recordPageReviewVerdict(scope, pageId, {
      sourceHash: hashPageSource(SOURCE),
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

describe("update — no page-scale write is ever paid twice", () => {
  test("a compile refusal KEEPS the submitted source as a draft", async () => {
    updateThrows = compileRefusal();
    const submitted = `${SOURCE}\nbroken((`;
    const result = await execManagePage({
      action: "update",
      definition: { code: { source: submitted } },
      rewrite: true,
    });
    // NOT an input-shape code: the call was well formed, the SOURCE was not.
    // Under INVALID_ARGS the loop guard tells the model "the call is
    // malformed, the tool is right, retry the same shape" — the advice that
    // produced seven identical refusals on 2026-08-28.
    expect(result["code"]).toBe("COMPILE_FAILED");
    expect(String(result["hint"])).toContain("kept for 15 minutes");
    expect(await readPageDraft(scope, pageId)).toBe(submitted);
  });

  test("get returns the kept draft, so reading and editing see one document", async () => {
    updateThrows = compileRefusal();
    const submitted = `${SOURCE}\nbroken((`;
    await execManagePage({
      action: "update",
      definition: { code: { source: submitted } },
      rewrite: true,
    });
    const view = await execManagePage({ action: "get" });
    const definition = view["definition"] as { code: { source: string } };
    expect(definition.code.source).toBe(submitted);
    expect(view["sourceIs"]).toBe("kept-draft");
  });

  test("the draft only wins when EVERY edit lands on it", async () => {
    updateThrows = compileRefusal();
    const submitted = `${SOURCE}\nbroken((`;
    await execManagePage({
      action: "update",
      definition: { code: { source: submitted } },
      rewrite: true,
    });
    updateThrows = null;
    // One anchor matches the draft, the other matches neither document. A
    // single match used to pin the whole batch to the draft and drop the
    // miss in silence, so the repair never landed and the same broken text
    // recompiled forever.
    const result = await execManagePage({
      action: "update",
      edits: [
        { oldString: "broken((", newString: "// fixed" },
        { oldString: "text that is in neither document", newString: "x" },
      ],
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["error"])).toContain("kept draft");
    // The draft is untouched: a batch that did not fully apply never became
    // the new draft, so the next attempt still starts from a known text.
    expect(await readPageDraft(scope, pageId)).toBe(submitted);
  });

  test("a compile refusal names the edits that did NOT land", async () => {
    // Partial application against the saved page: one anchor lands, one has
    // drifted, and the result does not compile. The miss used to be computed
    // and then dropped on this path — reported only when the write SUCCEEDED
    // — so an agent whose repair edit had silently missed read the same error
    // again and concluded the tool was ignoring it.
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
  });

  test("the next edits anchor on the kept draft, and success clears it", async () => {
    updateThrows = compileRefusal();
    const submitted = `${SOURCE}\nbroken((`;
    await execManagePage({
      action: "update",
      definition: { code: { source: submitted } },
      rewrite: true,
    });
    updateThrows = null;
    const result = await execManagePage({
      action: "update",
      edits: [{ oldString: "broken((", newString: "// fixed" }],
    });
    expect(result["editsNotApplied"]).toBeUndefined();
    const sent = updateCalls.at(-1)?.input["definition"] as {
      code: { source: string };
    };
    expect(sent.code.source).toBe(`${SOURCE}\n// fixed`);
    expect(await readPageDraft(scope, pageId)).toBeNull();
  });

  test("a destructive shrink is refused; growth passes without `rewrite`", async () => {
    const shrunk = await execManagePage({
      action: "update",
      definition: { code: { source: "<template><p>tiny</p></template>" } },
    });
    expect(shrunk["code"]).toBe("INVALID_ARGS");
    expect(String(shrunk["hint"])).toContain("rewrite: true");

    const grown = await execManagePage({
      action: "update",
      definition: { code: { source: `${SOURCE}\n<!-- a new section -->` } },
    });
    expect(grown["code"]).toBeUndefined();
    expect(updateCalls).toHaveLength(1);
  });
});

describe("create — the page that does not exist yet is the costliest to lose", () => {
  const NEW_SOURCE = [
    "<template>",
    "  <div><h1>Fresh board</h1></div>",
    "</template>",
    "<script setup>",
    "const oops = (",
    "</script>",
  ].join("\n");

  test("a refused create keeps its source under the turn's pending slot", async () => {
    createThrows = compileRefusal();
    const result = await execManagePage({
      action: "create",
      name: "Fresh board",
      definition: { code: { source: NEW_SOURCE } },
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["hint"])).toContain("WAS KEPT");
    expect(await readPageDraft(scope, "new")).toBe(NEW_SOURCE);
  });

  test("create + edits re-anchors on it, so the SFC is emitted once", async () => {
    createThrows = compileRefusal();
    await execManagePage({
      action: "create",
      name: "Fresh board",
      definition: { code: { source: NEW_SOURCE } },
    });
    createThrows = null;
    const result = await execManagePage({
      action: "create",
      name: "Fresh board",
      edits: [{ oldString: "const oops = (", newString: "const ok = 1;" }],
    });
    expect(result["code"]).toBeUndefined();
    expect(createCalls.at(-1)?.input.definition.code.source).toBe(
      NEW_SOURCE.replace("const oops = (", "const ok = 1;"),
    );
    // Landed, so the pending slot is gone: the next create starts clean.
    expect(await readPageDraft(scope, "new")).toBeNull();
  });

  test("edits with nothing pending say so instead of writing an empty page", async () => {
    const result = await execManagePage({
      action: "create",
      name: "Fresh board",
      edits: [{ oldString: "a", newString: "b" }],
    });
    expect(result["code"]).toBe("INVALID_ARGS");
    expect(String(result["error"])).toContain("no page to edit");
    expect(createCalls).toHaveLength(0);
  });
});
