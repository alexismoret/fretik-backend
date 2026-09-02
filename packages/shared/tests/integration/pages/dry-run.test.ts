import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PageDefinition } from "../../../src/schemas/pages";
import { dryRunPage } from "../../../src/services/pages/dry-run";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * `dryRunPage` over datasets that name a COLLECTION.
 *
 * The cases that carry their own rows stayed unit (`tests/unit/page-dry-run.test.ts`);
 * these reach the collections table, and the whole point of two of them is
 * which collections this team may read. Against the fake this file used to
 * share, `collections.findFirst` answered `undefined` to everything — so
 * "an unreadable collection degrades to a forbidden warning" was true of every
 * collection in existence, including the team's own, and the test could not
 * tell a refusal from a lookup that never happened.
 *
 * The two `forbidden` cases below are also the addition
 * `docs/TEST-TRIAGE.md` asks for beside `page-data-boundary`: an unknown id
 * and another team's id must both refuse, and one dataset's refusal must cost
 * that dataset's block rather than the page.
 */

let fx: WorkspaceFixture;
let otherFx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherFx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
  await otherFx.cleanup();
});

const withDatasets = (
  datasets: PageDefinition["datasets"],
  source = "<template><div>ok</div></template>",
): PageDefinition => ({
  version: 3,
  variables: [],
  datasets,
  operations: [],
  code: { source },
});

const run = (
  definition: PageDefinition,
  extra: { assumeSanitized?: true } = {},
) =>
  dryRunPage({
    definition,
    teamId: fx.teamId,
    userId: null,
    assumeCompiled: true,
    ...extra,
  });

describe("datasets that name a collection", () => {
  test("a dataset with no collectionId fails by message, not by throwing", async () => {
    const result = await run(
      withDatasets([{ id: "broken", kind: "collections" }]),
    );

    expect(
      result.warnings.some((w) => w.startsWith('dataset "broken" failed:')),
    ).toBe(true);
  });

  test("a collection id nothing owns degrades to a forbidden warning", async () => {
    const result = await run(
      withDatasets([
        {
          id: "records",
          kind: "collections",
          collectionId: "00000000-0000-4000-8000-000000000000",
        },
      ]),
    );

    expect(result.samples.records).toEqual({
      status: "forbidden",
      rowCount: 0,
    });
    expect(result.warnings).toContain(
      'dataset "records": this team cannot read that collection.',
    );
  });

  test("ANOTHER TEAM's records never appear, whatever the verdict says", async () => {
    // The claim that matters, and the one the old fake could not make: this
    // collection EXISTS, belongs to another organization entirely, and holds
    // rows. None of them may be sampled here.
    const foreign = await otherFx.createCollection();
    await otherFx.createRecord({
      collectionId: foreign.id,
      label: "a neighbour's row",
    });

    const result = await run(
      withDatasets([
        { id: "records", kind: "collections", collectionId: foreign.id },
      ]),
    );

    expect(result.samples.records?.rowCount).toBe(0);
    expect(JSON.stringify(result.samples.records)).not.toContain("neighbour");
  });

  test("KNOWN GAP: a foreign collection reports `ok`, not `forbidden`", async () => {
    // `collectionsSource` probes `where: { id }` with no scope at all, so the
    // `forbidden` verdict fires only for an id that exists NOWHERE. A page
    // pointed at another team's collection therefore reports an empty dataset
    // rather than a refusal — the rows are still scoped (above), so this is a
    // misleading MESSAGE, not a leak: the author is told "no rows, check your
    // filters" when the truth is "not your collection".
    //
    // Not fixed here because the correct predicate is not `teamId` equality:
    // reads legitimately honour cross-team grants (`collection-sharing/access`),
    // and `PageDataSource` is handed no `organizationId` to check one against.
    // Pinned so the day it is threaded through, this test fails and says so.
    const foreign = await otherFx.createCollection();

    const result = await run(
      withDatasets([
        { id: "records", kind: "collections", collectionId: foreign.id },
      ]),
    );

    expect(result.samples.records?.status).toBe("ok");
  });

  test("the team's OWN collection resolves — the refusal is not universal", async () => {
    // Without this, every assertion above is satisfied by a function that
    // refuses everything.
    const own = await fx.createCollection();

    const result = await run(
      withDatasets([
        { id: "records", kind: "collections", collectionId: own.id },
      ]),
    );

    expect(result.samples.records?.status).not.toBe("forbidden");
    expect(result.warnings).not.toContain(
      'dataset "records": this team cannot read that collection.',
    );
  });

  test("one dataset's refusal costs its block, not the page", async () => {
    const own = await fx.createCollection();

    const result = await run(
      withDatasets([
        { id: "mine", kind: "collections", collectionId: own.id },
        {
          id: "gone",
          kind: "collections",
          collectionId: "00000000-0000-4000-8000-000000000000",
        },
      ]),
    );

    expect(result.samples.gone?.status).toBe("forbidden");
    expect(result.samples.mine?.status).not.toBe("forbidden");
  });

  test("dryRunPage sanitizes the definition itself — its warnings include the static pass", async () => {
    const own = await fx.createCollection();
    const result = await run(
      withDatasets([
        {
          id: "derived",
          kind: "collections",
          mode: "aggregate",
          collectionId: own.id,
          metrics: [{ name: "spend", fn: "sum" }],
        },
      ]),
    );

    expect(
      result.warnings.some(
        (w) => w.includes('dataset "derived"') && w.includes("needs a `key`"),
      ),
    ).toBe(true);
  });

  test("assumeSanitized skips the static pass — the caller already ran it", async () => {
    const own = await fx.createCollection();
    const definition = withDatasets([
      {
        id: "derived",
        kind: "collections",
        mode: "aggregate",
        collectionId: own.id,
        metrics: [{ name: "spend", fn: "sum" }],
      },
    ]);

    // Same definition, both ways: the static finding is the difference.
    const fresh = await run(definition);
    const preSanitized = await run(definition, { assumeSanitized: true });

    expect(fresh.warnings.some((w) => w.includes("needs a `key`"))).toBe(true);
    expect(preSanitized.warnings.some((w) => w.includes("needs a `key`"))).toBe(
      false,
    );
    // The DATA phase still runs either way — that is the half a caller cannot
    // have done for itself.
    expect(preSanitized.samples).toEqual(fresh.samples);
  });
});
