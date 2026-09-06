import { badRequest } from "@fretik/shared/lib/errors";
import "@hono/zod-openapi";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { mockModule } from "../../../lib/mock-module";

/**
 * `pageBuild` is the only thing that publishes, so it is the only place where
 * refusing is worth what it costs.
 *
 * Two properties are pinned here because everything else in the tool set is
 * built on them: a build that refuses leaves the files exactly where they were
 * (the old shape discarded a 25 000-token emission and asked for it again), and
 * a project that would render invented rows never becomes a page at all.
 */

const PAGE_ID = "01a00000-0000-7000-8000-0000000000b1";

const realCreate = await import("@fretik/shared/services/pages/create");
const realUpdate = await import("@fretik/shared/services/pages/update");

const createCalls: unknown[] = [];
let createThrows: HTTPException | null = null;
await mockModule("@fretik/shared/services/pages/create", {
  createPage: async (args: unknown) => {
    createCalls.push(args);
    if (createThrows) throw createThrows;
    return { page: { id: PAGE_ID }, warnings: ["a warning from the save"] };
  },
});

const updateCalls: unknown[] = [];
await mockModule("@fretik/shared/services/pages/update", {
  updatePage: async (args: unknown) => {
    updateCalls.push(args);
    return { page: { id: PAGE_ID }, warnings: [] };
  },
});

afterAll(() => {
  void mock.module("@fretik/shared/services/pages/create", () => realCreate);
  void mock.module("@fretik/shared/services/pages/update", () => realUpdate);
});

const { buildPageProject, PAGE_BUILDER_AGENT_ID } =
  await import("../../../../src/services/page-project/build");
const { recordStepUsage, resetTurnUsage } =
  await import("../../../../src/lib/turn-usage");
const { emptyProjectState, hashProjectFiles, projectFiles } =
  await import("../../../../src/services/page-project/store");

const CLEAN = [
  "<template>",
  '  <div class="p-6"><h1>Orders</h1><UTable :data="rows" /></div>',
  "</template>",
  '<script setup lang="ts">',
  "import { ref } from 'vue';",
  "const rows = ref([]);",
  "</script>",
].join("\n");

/**
 * A page being created has to carry its design plan, so every fixture that is
 * about something else carries one. Tests that are about the plan pass their
 * own `page.json`.
 */
const PAGE_JSON = JSON.stringify({
  brief: {
    product: { job: "Track orders", audience: "Ops, mid-shift", features: [] },
    design: {
      archetype: "ledger",
      layout: "one wide table under a figure band",
      hierarchy: "the late count leads; the table is the body",
      containers: "detail inline, cancellation behind a modal",
      signature: "late rows carry the error hue down their left edge",
      defaultsRejected: ["four equal KPI cards → one figure and two small"],
      alternative: "a board — nothing in this data has a lane to move between",
    },
  },
});

const build = async (files: Record<string, string>) =>
  await buildPageProject({
    state: {
      ...emptyProjectState(),
      files: { "page.json": PAGE_JSON, ...files },
    },
    teamId: "team-1",
    organizationId: "org-1",
    userId: "user-1",
    conversationId: "conv-1",
    requester: undefined,
  });

beforeEach(() => {
  createCalls.length = 0;
  updateCalls.length = 0;
  createThrows = null;
});

describe("buildPageProject", () => {
  test("saves a clean project and reports the save's warnings", async () => {
    const result = await build({ "Page.vue": CLEAN });

    expect(result.ok).toBe(true);
    expect(createCalls).toHaveLength(1);
    if (!result.ok) throw new Error("expected a green build");
    expect(result.pageId).toBe(PAGE_ID);
    expect(result.warnings).toContain("a warning from the save");
    // The promoted hash is what makes the next `pageReview` able to tell a
    // stale copy from a fresh one.
    expect(result.state.builtHash).toBe(
      hashProjectFiles(
        projectFiles({ ...emptyProjectState(), files: { "Page.vue": CLEAN } }),
      ),
    );
  });

  test("refuses a project that invents rows, and saves NOTHING", async () => {
    const result = await build({
      "Page.vue": CLEAN,
      "components/Fake.vue": [
        "<template>",
        '  <UTable :data="rows" />',
        "</template>",
        '<script setup lang="ts">',
        "const rows = ref([]);",
        "const loadMockData = () => {",
        '  rows.value = [{ id: 1, name: "Acme", total: 1 }, { id: 2, name: "Globex", total: 2 }];',
        "};",
        "</script>",
      ].join("\n"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    // The refusal names the file and the line, which is what an edit needs.
    expect(result.errors.join(" ")).toContain("components/Fake.vue");
    expect(createCalls).toHaveLength(0);
  });

  test("a native control does not refuse the build — it fails the review", async () => {
    // The severity split, stated as behaviour: the page WORKS, so refusing
    // here would trade a working page for none.
    const result = await build({
      "Page.vue": CLEAN.replace(
        '<UTable :data="rows" />',
        "<select><option>a</option></select>",
      ),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected a green build");
    expect(result.warnings.join(" ")).toContain("native control");
  });

  test("names page.json's own path when its contract is wrong", async () => {
    const result = await build({
      "Page.vue": CLEAN,
      "page.json": '{ "datasets": [{ "id": "orders" }] }',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors.join(" ")).toContain("page.json");
    expect(createCalls).toHaveLength(0);
  });

  test("an empty entry is a refusal, not a blank page", async () => {
    const result = await build({ "Page.vue": "" });

    expect(result.ok).toBe(false);
    expect(createCalls).toHaveLength(0);
  });

  test("a service refusal comes back as named lines with the files untouched", async () => {
    createThrows = new HTTPException(400, {
      message: JSON.stringify(
        badRequest(
          "Page code failed to compile\n- Page.vue:2 unexpected token",
        ),
      ),
    });
    const result = await build({ "Page.vue": CLEAN });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors).toEqual(["Page.vue:2 unexpected token"]);
  });

  test("a page created without a design plan is refused", async () => {
    // The design is decided before it is built, and the only mechanism that
    // makes that true is this one: prose asked for a brief for weeks and the
    // pages that skipped it are the pages that came back as four equal cards.
    // Nothing is lost — the files stay in the working copy, and the fix is one
    // edit to page.json.
    const result = await buildPageProject({
      state: { ...emptyProjectState(), files: { "Page.vue": CLEAN } },
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      requester: undefined,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.errors.join(" ")).toContain("brief");
    expect(createCalls).toHaveLength(0);
  });

  test("a rescue saves the page anyway", async () => {
    // Finishing the build of a run that died. The plan rule has no addressee
    // once the builder is gone, and enforcing it here would trade a page that
    // exists for nothing at all.
    const result = await buildPageProject({
      state: { ...emptyProjectState(), files: { "Page.vue": CLEAN } },
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      requester: undefined,
      rescue: true,
    });

    expect(result.ok).toBe(true);
    expect(createCalls).toHaveLength(1);
  });
});

/** Walk a path of keys off an `unknown` without asserting a shape onto it. */
const readNumber = (source: unknown, ...path: string[]): number | undefined => {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = Reflect.get(cursor, key);
  }
  return typeof cursor === "number" ? cursor : undefined;
};

/**
 * The version row carries what the build cost, first-hand.
 *
 * The alternative — asking Langfuse afterwards with the stored `traceId` — is
 * how a 22x fan-out came to be reported as a real bill on 2026-09-05. A number
 * written by the process that spent it cannot be multiplied by someone else's
 * ingestion mode.
 */
describe("buildPageProject — what the version says it cost", () => {
  test("a green build stamps the builder's spend on the version", async () => {
    resetTurnUsage();
    recordStepUsage("turn-9", PAGE_BUILDER_AGENT_ID, {
      steps: 12,
      inputTokens: 900_000,
      cacheReadTokens: 780_000,
      cacheWriteTokens: 0,
      outputTokens: 21_000,
      reasoningTokens: 6_400,
      costUsd: 0.28123,
      costedSteps: 12,
      providers: {
        "google-vertex": {
          steps: 9,
          inputTokens: 700_000,
          cacheReadTokens: 690_000,
        },
        "google-ai-studio": {
          steps: 3,
          inputTokens: 200_000,
          cacheReadTokens: 90_000,
        },
      },
    });
    // The parent's own steps are in the same turn and must NOT land here:
    // this row is what the PAGE cost.
    recordStepUsage("turn-9", "chatbot", {
      steps: 4,
      inputTokens: 40_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 900,
      reasoningTokens: 0,
      costUsd: 0.05,
      costedSteps: 4,
      providers: {
        "google-vertex": { steps: 4, inputTokens: 40_000, cacheReadTokens: 0 },
      },
    });

    const result = await buildPageProject({
      state: {
        ...emptyProjectState(),
        files: { "page.json": PAGE_JSON, "Page.vue": CLEAN },
      },
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      requester: undefined,
      traceId: "turn-9.page",
    });

    expect(result.ok).toBe(true);
    expect(readNumber(createCalls[0], "versionMeta", "usage", "steps")).toBe(
      12,
    );
    expect(readNumber(createCalls[0], "versionMeta", "usage", "costUsd")).toBe(
      0.2812,
    );
    expect(
      readNumber(createCalls[0], "versionMeta", "usage", "reasoningTokens"),
    ).toBe(6_400);
  });

  test("a build nobody metered carries no usage rather than a zero", async () => {
    // A zero would read as a free page. Absent reads as unmeasured, which is
    // what it is.
    resetTurnUsage();

    const result = await buildPageProject({
      state: {
        ...emptyProjectState(),
        files: { "page.json": PAGE_JSON, "Page.vue": CLEAN },
      },
      teamId: "team-1",
      organizationId: "org-1",
      userId: "user-1",
      conversationId: "conv-1",
      requester: undefined,
      traceId: "turn-unmetered.page",
    });

    expect(result.ok).toBe(true);
    expect(
      readNumber(createCalls[0], "versionMeta", "usage", "steps"),
    ).toBeUndefined();
  });
});
