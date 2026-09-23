import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runColumnsWalk } from "../../../src/services/collection-sync/walk-by-match-field";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import {
  createColumnsWalkSource,
  dbNow,
  singlePageUpstream,
} from "./lib/table-source";

/**
 * The walk that costs nothing.
 *
 * A `columns` source is routinely declared before the `table` source that
 * fills its key has ever run — the team connects Akanea, then connects Stripe
 * against an invoice reference Akanea has not brought over yet. Walking an
 * app's whole list to match it against an empty column is the purest waste
 * this engine can produce: every page paid for, nothing found, repeated on
 * every tick until somebody notices.
 *
 * The assertion is on the CALL COUNT, because that is the only thing that
 * distinguishes this from a walk that simply matched nothing.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

describe("before the first call", () => {
  test("a collection with no key anywhere makes zero calls", async () => {
    const h = await createColumnsWalkSource(fx, { keys: [null, null] });
    const upstream = singlePageUpstream([
      { id: "A", label: "Row A", amount: 1 },
    ]);

    const result = await runColumnsWalk({
      source: await h.reload(),
      action: upstream.action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: await dbNow(),
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") expect(result.reason).toBe("no_match_keys");
    expect(upstream.calls).toHaveLength(0);
    expect(result.counts.upstreamCalls).toBe(0);
  });

  test("a key held only by another team does not count as one", async () => {
    // Same extension table, different tenant. Without `_team_id` on the
    // pre-check, one team's data would make another team's source walk.
    const other = await fx.createTeam();
    const h = await createColumnsWalkSource(fx, {
      keys: [null],
      otherTeamId: other.id,
      otherTeamKeys: ["THEIRS"],
    });
    const upstream = singlePageUpstream([
      { id: "THEIRS", label: "Row", amount: 1 },
    ]);

    const result = await runColumnsWalk({
      source: await h.reload(),
      action: upstream.action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: await dbNow(),
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(result.kind).toBe("skipped");
    expect(upstream.calls).toHaveLength(0);
  });

  test("one key is enough to walk", async () => {
    const h = await createColumnsWalkSource(fx, { keys: [null, "ONE"] });
    const upstream = singlePageUpstream([
      { id: "ONE", label: "Row", amount: 5 },
    ]);

    const result = await runColumnsWalk({
      source: await h.reload(),
      action: upstream.action,
      deadlineAt: Date.now() + 60_000,
      runId: crypto.randomUUID(),
      walkStartedAt: await dbNow(),
      configHash: "fixed",
      fullWalk: true,
      ignoreOrphanFloor: false,
    });

    expect(result.kind).toBe("complete");
    expect(upstream.calls).toHaveLength(1);
    expect(result.counts.updatedCount).toBe(1);
  });
});
