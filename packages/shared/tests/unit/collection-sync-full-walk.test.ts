import { describe, expect, test } from "bun:test";
import type { CollectionSyncSource } from "../../src/db/schema";
import { SYNC_LIMITS, type SyncArgs } from "../../src/schemas/collection-sync";
import { shouldWalkEverything } from "../../src/services/collection-sync/run-source";

/**
 * Full walk or incremental — the decision the orphan diff hangs off.
 *
 * A full walk holds the whole upstream truth, so "not in the answer" means
 * "gone" and the diff may run. An incremental answer holds only what changed,
 * so the same sentence would declare the untouched collection deleted. The
 * cadence half of that (a periodic full pass so deletions are eventually seen)
 * was implemented; the other half — whether the source can read incrementally
 * AT ALL — was described in the comment and missing from the code.
 *
 * Observed in the browser on 2026-09-19 against a real warehouse: a source
 * whose action takes no `since` parameter ran a second time, the app answered
 * with zero rows, and the run was recorded `success` with `orphanCount: 0`
 * against 200 tracked records. No floor, no `pendingFullResync` — the one
 * reading the floor exists to refuse.
 *
 * Unit because it is a pure function of three columns, and because the
 * integration suites pass `fullWalk` in by hand: they exercise what the walk
 * DOES with the answer, never how the answer is chosen.
 */

const source = (
  args: SyncArgs,
  lastSuccessAt: Date | null,
  lastFullWalkAt: Date | null,
): Pick<CollectionSyncSource, "args" | "lastSuccessAt" | "lastFullWalkAt"> => ({
  args,
  lastSuccessAt,
  lastFullWalkAt,
});

const now = new Date("2026-09-19T12:00:00.000Z");
const minutesAgo = (n: number): Date => new Date(now.getTime() - n * 60_000);

/** An action bounded by what changed, the way `resolve-args` reads it. */
const incremental: SyncArgs = { updated_since: { $since: true } };
/** The same source with nothing bound — every answer is the whole table. */
const unbounded: SyncArgs = { filters: 'Status="open"', limit: 200 };

describe("a source that cannot read incrementally walks everything, every time", () => {
  test("no `$since` binding ⇒ full, even minutes after the last full walk", () => {
    expect(
      shouldWalkEverything(
        source(unbounded, minutesAgo(1), minutesAgo(1)),
        now,
      ),
    ).toBe(true);
  });

  test("a binding nested in an object still counts as incremental", () => {
    expect(
      shouldWalkEverything(
        source(
          { window: { from: { $since: true } } },
          minutesAgo(1),
          minutesAgo(1),
        ),
        now,
      ),
    ).toBe(false);
  });
});

describe("an incremental source walks everything on the cadence", () => {
  test("never run ⇒ full", () => {
    expect(shouldWalkEverything(source(incremental, null, null), now)).toBe(
      true,
    );
  });

  test("run, but never fully ⇒ full", () => {
    expect(
      shouldWalkEverything(source(incremental, minutesAgo(30), null), now),
    ).toBe(true);
  });

  test("inside the interval ⇒ incremental", () => {
    expect(
      shouldWalkEverything(
        source(
          incremental,
          minutesAgo(30),
          minutesAgo(SYNC_LIMITS.fullWalkIntervalMinutes - 1),
        ),
        now,
      ),
    ).toBe(false);
  });

  test("past the interval ⇒ full again", () => {
    expect(
      shouldWalkEverything(
        source(
          incremental,
          minutesAgo(30),
          minutesAgo(SYNC_LIMITS.fullWalkIntervalMinutes),
        ),
        now,
      ),
    ).toBe(true);
  });
});
