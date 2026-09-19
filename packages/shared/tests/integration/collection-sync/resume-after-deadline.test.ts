import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runTableSync } from "../../../src/services/collection-sync/run-table-sync";
import { UpstreamRateLimitedError } from "../../../src/services/external-apps/exec/governor/upstream-error";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  createTableSource,
  dbNow,
  offsetUpstream,
  readTracked,
  row,
  type TableSourceFixture,
  type UpstreamRow,
} from "./lib/table-source";

/**
 * A walk that runs out of budget SUSPENDS and resumes, rather than truncating.
 *
 * The behaviour this replaces: a run that hit its ten-minute budget threw away
 * every row it had read and reported `truncated`. A collection too large to
 * walk in one budget therefore never finished loading — not slowly, never. And
 * because the rows were dropped, the next run started again from page one and
 * hit the same wall, for ever.
 *
 * What the suspension has to get right is narrow and easy to get wrong: the
 * stored position must point at the page AFTER the last one WRITTEN. One off in
 * either direction is a page silently skipped or a page re-diffed for ever.
 *
 * Integration because the rows the first leg wrote are the second leg's diff
 * input: the two legs only agree if the records and their hashes are really in
 * Postgres between them.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

/** Five pages of two rows each: r0…r9, then the empty last page. */
const fivePages = (): UpstreamRow[][] => [
  [row("r0"), row("r1")],
  [row("r2"), row("r3")],
  [row("r4"), row("r5")],
  [row("r6"), row("r7")],
  [row("r8"), row("r9")],
  [],
];

/** A leg, with the walk-wide identity every leg of one walk shares. */
const leg = async (
  fixture: TableSourceFixture,
  walk: { runId: string; walkStartedAt: Date },
  action: Parameters<typeof runTableSync>[0]["action"],
  extra: Partial<Parameters<typeof runTableSync>[0]> = {},
) =>
  runTableSync({
    source: await fixture.reload(),
    action,
    deadlineAt: Date.now() + 60_000,
    runId: walk.runId,
    walkStartedAt: walk.walkStartedAt,
    configHash: "fixed",
    fullWalk: true,
    ignoreOrphanFloor: false,
    ...extra,
  });

describe("a suspended walk", () => {
  test("stops at the deadline, keeps what it wrote, and resumes from the next page", async () => {
    const fixture = await createTableSource(fx);
    const walk = { runId: crypto.randomUUID(), walkStartedAt: await dbNow() };

    // Page index 1 takes 300 ms; the budget is 150. The walk therefore answers
    // pages 0 and 1 and is over budget when it checks before page 2.
    const first = offsetUpstream(fivePages(), {
      pageSize: 2,
      stallAfterPage: 1,
      stallMs: 300,
    });
    const suspended = await leg(fixture, walk, first.action, {
      deadlineAt: Date.now() + 150,
    });

    expect(suspended.kind).toBe("suspended");
    if (suspended.kind !== "suspended") throw new Error("expected suspension");
    expect(suspended.reason).toBe("deadline");
    expect(suspended.counts.createdCount).toBe(4);
    // Four rows read, so the next call asks from offset 4 — not 2 (a page
    // re-read for ever) and not 6 (two rows silently skipped).
    expect(suspended.checkpoint.position).toEqual({
      kind: "offset",
      offset: 4,
    });
    expect(suspended.checkpoint.runId).toBe(walk.runId);
    expect(suspended.checkpoint.legs).toBe(2);
    expect(suspended.checkpoint.fullWalk).toBe(true);

    // The four rows are COMMITTED. This is the whole point of the change.
    expect((await readTracked(fixture.source.id)).length).toBe(4);

    // Leg two: the remaining pages. Its first call must carry the stored
    // offset, which the fake records verbatim.
    const second = offsetUpstream(fivePages().slice(2), { pageSize: 2 });
    const completed = await leg(fixture, walk, second.action, {
      resume: suspended.checkpoint,
    });

    expect(second.calls[0]?.offset).toBe(4);
    expect(completed.kind).toBe("complete");
    expect(completed.counts.createdCount).toBe(10);
    expect(completed.counts.orphanCount).toBe(0);
    expect((await readTracked(fixture.source.id)).length).toBe(10);
  });

  test("a refusal suspends too, and carries the wait back", async () => {
    const fixture = await createTableSource(fx);
    const walk = { runId: crypto.randomUUID(), walkStartedAt: await dbNow() };

    const refusing = offsetUpstream(fivePages(), {
      pageSize: 2,
      throwOnCall: {
        index: 2,
        error: new UpstreamRateLimitedError(
          fixture.source.connectionId ?? "",
          "Acme",
          4_000,
          "conn_rate",
        ),
      },
    });
    const suspended = await leg(fixture, walk, refusing.action);

    expect(suspended.kind).toBe("suspended");
    if (suspended.kind !== "suspended") throw new Error("expected suspension");
    // A refusal is not a failure: the four rows already read are kept, the
    // position points at the page that was refused, and the wait the governor
    // named becomes the continuation's delay.
    expect(suspended.reason).toBe("rate_limited");
    expect(suspended.retryAfterMs).toBe(4_000);
    expect(suspended.checkpoint.position).toEqual({
      kind: "offset",
      offset: 4,
    });
    expect((await readTracked(fixture.source.id)).length).toBe(4);

    const completed = await leg(
      fixture,
      walk,
      offsetUpstream(fivePages().slice(2), { pageSize: 2 }).action,
      { resume: suspended.checkpoint },
    );
    expect(completed.kind).toBe("complete");
    expect((await readTracked(fixture.source.id)).length).toBe(10);
  });

  test("counts accumulate across legs rather than restarting", async () => {
    const fixture = await createTableSource(fx);
    const walk = { runId: crypto.randomUUID(), walkStartedAt: await dbNow() };

    const suspended = await leg(
      fixture,
      walk,
      offsetUpstream(fivePages(), {
        pageSize: 2,
        stallAfterPage: 2,
        stallMs: 300,
      }).action,
      { deadlineAt: Date.now() + 150 },
    );
    if (suspended.kind !== "suspended") throw new Error("expected suspension");
    expect(suspended.counts.createdCount).toBe(6);

    const second = offsetUpstream(fivePages().slice(3), { pageSize: 2 });
    const completed = await leg(fixture, walk, second.action, {
      resume: suspended.checkpoint,
    });

    // 6 + 4, not 4. A walk is one run, so its counters are the walk's — and
    // the call count is the two legs added, not the second leg's own.
    expect(completed.counts.createdCount).toBe(10);
    expect(completed.counts.upstreamCalls).toBe(
      suspended.counts.upstreamCalls + second.calls.length,
    );
    expect(second.calls.length).toBeGreaterThan(0);
  });

  test("the orphan bracket runs once, at the END of the last leg", async () => {
    const fixture = await createTableSource(fx);
    // Seed ten rows, then walk them again in two legs. Nothing may be orphaned
    // by the first leg — it has only seen four of the ten, which is exactly the
    // shape that would empty a collection if a suspension diffed.
    await leg(
      fixture,
      { runId: crypto.randomUUID(), walkStartedAt: await dbNow() },
      offsetUpstream(fivePages(), { pageSize: 2 }).action,
    );
    expect((await readTracked(fixture.source.id)).length).toBe(10);

    const walk = { runId: crypto.randomUUID(), walkStartedAt: await dbNow() };
    const suspended = await leg(
      fixture,
      walk,
      offsetUpstream(fivePages(), {
        pageSize: 2,
        stallAfterPage: 1,
        stallMs: 300,
      }).action,
      { deadlineAt: Date.now() + 150 },
    );
    if (suspended.kind !== "suspended") throw new Error("expected suspension");
    expect(suspended.counts.orphanCount).toBe(0);

    const tracked = await readTracked(fixture.source.id);
    expect(tracked.every((entry) => entry.status === "ok")).toBe(true);

    const completed = await leg(
      fixture,
      walk,
      offsetUpstream(fivePages().slice(2), { pageSize: 2 }).action,
      { resume: suspended.checkpoint },
    );

    // Every row was seen across the two legs, so none is an orphan — which is
    // only true because `walkStartedAt` is the WALK's start and not the leg's.
    expect(completed.kind).toBe("complete");
    expect(completed.counts.orphanCount).toBe(0);
    expect(completed.counts.unchangedCount).toBe(10);
  });
});
