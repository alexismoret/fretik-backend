import { describe, expect, test } from "bun:test";
import type { Page } from "../../src/db/schema";
import type { PageDefinition } from "../../src/schemas/pages";
import { buildPageCard } from "../../src/services/pages/vector-refresh";

/**
 * The searchable card is what makes a page findable from a request that never
 * says "page". Same two properties as the workflow card — every field that
 * describes the page reaches it, and it is stable for an unchanged page — plus
 * one that is specific and load-bearing: VISIBILITY must be in the text.
 *
 * The `content_hash` short-circuit skips the re-embed when the card is
 * unchanged, and turning a page private changes nothing else about it. Were
 * visibility absent from the card, a privatised page would keep its stale
 * team-wide vector row and stay discoverable by everyone.
 */

const COLLECTIONS = new Map([
  ["22222222-2222-7222-8222-222222222222", "Invoices"],
]);

const definition = (
  overrides: Partial<PageDefinition> = {},
): PageDefinition => ({
  version: 3,
  brief: {
    product: {
      job: "See this month's margins without exporting anything.",
      audience: "Finance, on the Monday close.",
      features: ["Filter by client", "Drill into a single invoice"],
    },
    design: { layout: "Header, then a chart over a table.", signature: "…" },
  },
  variables: [],
  datasets: [
    {
      id: "invoices",
      kind: "collections",
      collectionId: "22222222-2222-7222-8222-222222222222",
    },
  ],
  operations: [],
  code: { source: "<template><div /></template>" },
  ...overrides,
});

const page = (overrides: Partial<Page> = {}): Page =>
  ({
    id: "11111111-1111-7111-8111-111111111111",
    name: "Monthly margins",
    description: "",
    userId: null,
    publicToken: null,
    definition: definition(),
    ...overrides,
  }) as Page;

describe("buildPageCard", () => {
  test("is stable for an unchanged page", () => {
    expect(buildPageCard(page(), COLLECTIONS)).toBe(
      buildPageCard(page(), COLLECTIONS),
    );
  });

  test("carries what the page is for, in the words a request would use", () => {
    const card = buildPageCard(page(), COLLECTIONS);
    expect(card).toContain("Monthly margins");
    expect(card).toContain("See this month's margins without exporting");
    expect(card).toContain("Finance, on the Monday close.");
    expect(card).toContain("Filter by client");
    expect(card).toContain("Invoices");
  });

  test("changes when the page is privatised — else the card goes stale", () => {
    const shared = buildPageCard(page(), COLLECTIONS);
    const privatised = buildPageCard(
      page({ userId: "33333333-3333-7333-8333-333333333333" }),
      COLLECTIONS,
    );
    expect(privatised).not.toBe(shared);
    expect(shared).toContain("team-shared");
    expect(privatised).toContain("private");
  });

  test("changes when the page is published", () => {
    const published = buildPageCard(
      page({ publicToken: "44444444-4444-7444-8444-444444444444" }),
      COLLECTIONS,
    );
    expect(published).not.toBe(buildPageCard(page(), COLLECTIONS));
    expect(published).toContain("published at a public link");
  });

  test("changes when the brief or the datasets change", () => {
    const before = buildPageCard(page(), COLLECTIONS);
    expect(
      buildPageCard(
        page({
          definition: definition({
            brief: {
              product: {
                job: "Chase unpaid invoices.",
                audience: "Finance.",
                features: [],
              },
              design: { layout: "A list.", signature: "…" },
            },
          }),
        }),
        COLLECTIONS,
      ),
    ).not.toBe(before);
    expect(
      buildPageCard(
        page({ definition: definition({ datasets: [] }) }),
        COLLECTIONS,
      ),
    ).not.toBe(before);
  });

  test("degrades to name and visibility for a page with no brief", () => {
    const card = buildPageCard(
      page({
        name: "Scratch view",
        definition: definition({ brief: undefined, datasets: [] }),
      }),
      COLLECTIONS,
    );
    expect(card).toContain("Scratch view");
    expect(card).toContain("team-shared");
    expect(card).not.toContain("Job:");
  });

  test("names the actions a page can take, not just what it shows", () => {
    const card = buildPageCard(
      page({
        definition: definition({
          operations: [
            {
              id: "approve",
              kind: "record",
              collectionId: "22222222-2222-7222-8222-222222222222",
              mode: "update",
            },
          ],
        }),
      }),
      COLLECTIONS,
    );
    expect(card).toContain("Actions:");
    expect(card).toContain("update Invoices");
  });
});
