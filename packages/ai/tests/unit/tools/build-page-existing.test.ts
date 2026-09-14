import { describe, expect, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * A repair CHANGES the page. It does not build a second one beside it.
 *
 * `buildPageProject` updates the page its working copy names and creates one
 * when the copy names none, so the id has to reach the copy before the builder
 * writes anything. It used to reach it only if the model passed `pageId` to
 * its first `pageRead` — prose, aimed at a model that has just been handed the
 * whole source and told not to read it back. `describePage` seeds the copy
 * itself, and this suite is what says so.
 */

interface StoredPage {
  id: string;
  name: string;
  description?: string;
  definition: { code: { source: string; files?: Record<string, string> } };
}

let stored: StoredPage | null = null;

await mockModule("@fretik/shared/services/pages/retrieve", {
  getPage: async ({ pageId }: { pageId: string }) => {
    if (stored === null || stored.id !== pageId) throw new Error("404");
    return stored;
  },
});
await mockModule("@fretik/shared/services/organization/member-role", {
  isOrgAdmin: async () => false,
});

const { describePage } = await import("../../../src/tools/build-page");
const { readPageProject, writePageProject, emptyProjectState } =
  await import("../../../src/services/page-project/store");

const ctx = (traceId: string) =>
  ({
    teamId: "team-1",
    organizationId: "org-1",
    userId: "user-1",
    traceId,
  }) as never;

const freshTurn = (): string => `trace-${crypto.randomUUID()}`;

const page = (files?: Record<string, string>): StoredPage => ({
  id: "0199a0b0-0000-7000-8000-000000000000",
  name: "Orders",
  definition: {
    code: {
      source: "<template><p>orders</p></template>",
      ...(files ? { files } : {}),
    },
  },
});

describe("describePage", () => {
  test("seeds the working copy with the page id, so the build updates it", async () => {
    stored = page();
    const traceId = freshTurn();

    await describePage(stored.id, ctx(traceId));

    const copy = await readPageProject(`${traceId}.page`);
    expect(copy?.pageId).toBe(stored.id);
    // Seeded, never promoted: `builtHash` is what a build that SAVED leaves.
    expect(copy?.builtHash).toBeUndefined();
    expect(copy?.files["Page.vue"]).toContain("orders");
    expect(copy?.files["page.json"]).toContain("Orders");
  });

  test("prints page.json first, then the entry, then the rest", async () => {
    stored = page({ "components/Row.vue": "<template><li /></template>" });

    const block = await describePage(stored.id, ctx(freshTurn()));

    expect(block.indexOf("```json page.json")).toBeLessThan(
      block.indexOf("```vue Page.vue"),
    );
    expect(block.indexOf("```vue Page.vue")).toBeLessThan(
      block.indexOf("```vue components/Row.vue"),
    );
    expect(block).toContain("</existing_page>");
  });

  test("a copy already open on this page is resumed, not reverted", async () => {
    stored = page();
    const traceId = freshTurn();
    await writePageProject(`${traceId}.page`, {
      ...emptyProjectState(),
      pageId: stored.id,
      files: { "Page.vue": "<template><p>work in progress</p></template>" },
    });

    const block = await describePage(stored.id, ctx(traceId));

    expect(block).toContain("work in progress");
    expect(block).not.toContain("<p>orders</p>");
  });

  test("a page too heavy to print is named, never silently cut", async () => {
    stored = page({ "components/Huge.vue": "x".repeat(120_000) });

    const block = await describePage(stored.id, ctx(freshTurn()));

    expect(block.length).toBeLessThan(95_000);
    expect(block).toContain("Not printed, too large");
    expect(block).toContain("components/Huge.vue");
    // The entry is small and ranks ahead of it, so it still goes out.
    expect(block).toContain("```vue Page.vue");
  });

  test("a page it cannot read is announced — the silent version builds a duplicate", async () => {
    stored = null;

    const block = await describePage(
      "0199a0b0-0000-7000-8000-00000000dead",
      ctx(freshTurn()),
    );

    expect(block).toContain("This page EXISTS");
    expect(block).toContain("pageRead");
    expect(block).toContain("0199a0b0-0000-7000-8000-00000000dead");
  });
});
