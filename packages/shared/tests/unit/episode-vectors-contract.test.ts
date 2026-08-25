import { describe, expect, test } from "bun:test";
import { deleteEpisodeVectors } from "../../src/services/episodes/vectors";

/**
 * `deleteEpisodeVectors` must THROW on failure, and this test exists to keep it
 * that way.
 *
 * It used to have no try/catch and six `void` callers, which made every one of
 * them an unhandled promise rejection. The tempting fix — wrap the body, like
 * its five sibling delete helpers — would have been silently wrong: four
 * callers `await` it for correctness, and the loudest is `consolidateEpisodes`,
 * which drops the SUPERSEDED episodes' vectors right after writing the
 * survivor's. A swallowed failure there leaves both in recall: exactly the
 * duplication consolidation exists to remove.
 *
 * The right fix was at the call sites (await them, and join the transaction
 * where the demotion happens), not in here.
 */

describe("deleteEpisodeVectors contract", () => {
  test("no-ops on an empty list without touching the database", async () => {
    // Also the guard that keeps the sweep cheap: a pass that found nothing
    // must not issue a statement per source type.
    expect(await deleteEpisodeVectors([])).toBeUndefined();
  });

  test("rejects rather than swallowing a database failure", async () => {
    // Written as an explicit try/catch rather than `.rejects.toThrow()`:
    // Bun types that matcher as returning void, so the `await` linters want
    // removed is exactly the one that makes it assert anything. Without it the
    // test passed no matter what the function did.
    //
    // An id Postgres cannot cast to uuid, chosen so the statement fails BOTH
    // ways: against a reachable database it is a cast error, and under the
    // test preload's dead-port URL it is a connection error. A valid uuid
    // would delete zero rows and succeed on a real database — the test would
    // then only pass when nothing was listening, which is no test at all.
    // What is asserted is the SHAPE of the outcome, never the error text.
    let rejected = false;
    try {
      await deleteEpisodeVectors(["not-a-uuid"]);
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
