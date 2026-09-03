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

const { buildPageProject } =
  await import("../../../../src/services/page-project/build");
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

const build = async (files: Record<string, string>) =>
  await buildPageProject({
    state: { ...emptyProjectState(), files },
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
});
