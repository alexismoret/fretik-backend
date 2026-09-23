import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runTableWalk } from "../../../src/services/collection-sync/walk-by-external-id";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  countRecordEvents,
  createTableSource,
  dbNow,
  offsetUpstream,
  readTracked,
  row,
  type TableSourceFixture,
} from "./lib/table-source";

/**
 * The diff, page by page: the same answer twice writes once.
 *
 * This is the property the whole feature's cost rests on. An hourly sync of a
 * collection where nothing moved must write NO record UPDATE — because an
 * UPDATE writes a `domain_events` row, which re-embeds the record card and
 * feeds the workflow-trigger sweep. Twice the writes is twice the embedding
 * bill, on data that did not change.
 *
 * Integration because the identity is the unique index
 * (`collection_records_sync_external_uniq`) and the change detector is a row in
 * `record_sync_state`. The page-scoped diff query is new here — it replaced an
 * in-memory Map of the whole collection — and the only way to see that it finds
 * the same records the Map did is to ask Postgres.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const runOnce = async (
  fixture: TableSourceFixture,
  pages: ReturnType<typeof row>[][],
) => {
  const upstream = offsetUpstream(pages, { pageSize: 2 });
  const source = await fixture.reload();
  const outcome = await runTableWalk({
    source,
    action: upstream.action,
    deadlineAt: Date.now() + 60_000,
    runId: crypto.randomUUID(),
    // `dbNow`, never `new Date()`. With the host clock a moment ahead of the
    // database's, the rows of the FIRST page land "before" the walk started
    // while a later page's land after — so the bracket marks the early ones
    // `missing`, and the next run then sees them as changed. That is what made
    // this suite fail only under load, and it is the same clock rule the runner
    // itself now enforces by taking the run row's `started_at`.
    walkStartedAt: await dbNow(),
    configHash: "fixed",
    fullWalk: true,
    ignoreOrphanFloor: false,
  });
  return { outcome, upstream };
};

describe("a table run's diff", () => {
  test("creates on the first pass and writes nothing on an identical second", async () => {
    const fixture = await createTableSource(fx);
    const pages = [[row("a"), row("b")], [row("c")], []];

    const first = await runOnce(fixture, pages);
    expect(first.outcome.kind).toBe("complete");
    expect(first.outcome.counts.createdCount).toBe(3);
    expect(first.outcome.counts.updatedCount).toBe(0);
    expect(first.outcome.counts.unchangedCount).toBe(0);

    const second = await runOnce(fixture, pages);
    expect(second.outcome.counts.createdCount).toBe(0);
    expect(second.outcome.counts.updatedCount).toBe(0);
    expect(second.outcome.counts.unchangedCount).toBe(3);

    // One `record.created` per row and NOT a second one — which is also what
    // proves the second pass matched by external id rather than inserting
    // again and being refused by the unique index.
    expect(
      await countRecordEvents(fixture.collectionId, "record.created"),
    ).toBe(3);
    expect(
      await countRecordEvents(fixture.collectionId, "record.updated"),
    ).toBe(0);

    const tracked = await readTracked(fixture.source.id);
    expect(tracked.map((entry) => entry.externalId)).toEqual(["a", "b", "c"]);
    expect(tracked.every((entry) => entry.status === "ok")).toBe(true);
  });

  test("a changed value costs exactly one update and one journal entry", async () => {
    const fixture = await createTableSource(fx);
    await runOnce(fixture, [[row("a", 1), row("b", 1)], []]);

    const changed = await runOnce(fixture, [[row("a", 1), row("b", 99)], []]);

    expect(changed.outcome.counts.updatedCount).toBe(1);
    expect(changed.outcome.counts.unchangedCount).toBe(1);
    expect(
      await countRecordEvents(fixture.collectionId, "record.updated"),
    ).toBe(1);
  });

  test("replaying one page — a resumed leg re-reading it — creates nothing twice", async () => {
    const fixture = await createTableSource(fx);
    const page = [row("a"), row("b")];

    await runOnce(fixture, [page, []]);
    const replay = await runOnce(fixture, [page, page, []]);

    // The page arrived twice in ONE walk. Both times the diff found the
    // records already there and hashed identical, so both times it wrote
    // nothing — which is what makes a resumed leg safe to overlap.
    expect(replay.outcome.counts.createdCount).toBe(0);
    expect(replay.outcome.counts.updatedCount).toBe(0);
    expect(replay.outcome.counts.unchangedCount).toBe(4);
    expect((await readTracked(fixture.source.id)).length).toBe(2);
  });

  test("a row with no id at the external path is counted and dropped", async () => {
    const fixture = await createTableSource(fx);
    const nameless = { label: "no id here", amount: 3 };

    const outcome = await runTableWalk({
      source: await fixture.reload(),
      action: offsetUpstream([[row("a"), nameless as never], []], {
        pageSize: 2,
      }).action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: await dbNow(),
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(outcome.counts.createdCount).toBe(1);
    expect(outcome.counts.failedCount).toBe(1);
    expect((await readTracked(fixture.source.id)).length).toBe(1);
  });
});
