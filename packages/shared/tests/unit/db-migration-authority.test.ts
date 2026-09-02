import { afterEach, describe, expect, test } from "bun:test";
import { runMigrationsWithLock } from "../../src/db/migrations";

/**
 * The rule that would have prevented the 2026-08-30 incident: applying
 * migrations takes an authority the ENVIRONMENT backs, and a process that
 * cannot show one never opens a connection.
 *
 * These tests assert the refusal, which is the half that matters and the half
 * a database cannot help with — the refusal happens before any client is
 * constructed, which is exactly why it can be tested here. Applying migrations
 * for real is an integration concern (a disposable database, `db:migrate`, and
 * the CI job that replays every migration from scratch).
 */

const originalRunMigrations = process.env.RUN_MIGRATIONS;

/**
 * The rejection, as a value.
 *
 * `expect(...).rejects.toThrow()` is typed as returning `void` in bun:test, so
 * awaiting it is a lint error and not awaiting it lets the test end before the
 * promise settles. Catching the rejection avoids both, and lets each test
 * assert on an `Error` — which is itself part of the contract here: these
 * paths used to `throw "a string"`.
 */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error(`Expected an Error, got ${typeof err}: ${String(err)}`, {
      cause: err,
    });
  }
  throw new Error("Expected the call to be refused, but it resolved");
};

afterEach(() => {
  if (originalRunMigrations === undefined) delete process.env.RUN_MIGRATIONS;
  else process.env.RUN_MIGRATIONS = originalRunMigrations;
});

describe("runMigrationsWithLock — authority", () => {
  test("a service that did not opt in migrates nothing", async () => {
    delete process.env.RUN_MIGRATIONS;

    // The dead-port DATABASE_URL the preload installs means a connection
    // attempt would surface as ECONNREFUSED. Getting the refusal instead is
    // the proof that nothing was even dialled.
    const err = await rejection(
      runMigrationsWithLock({ kind: "service-boot" }),
    );
    expect(err.message).toContain("did not opt in");
  });

  test('`RUN_MIGRATIONS` set to anything but "true" is not opting in', async () => {
    process.env.RUN_MIGRATIONS = "1";

    const err = await rejection(
      runMigrationsWithLock({ kind: "service-boot" }),
    );
    expect(err.message).toContain("did not opt in");
  });

  test("an operator does not need the service opt-in, and reaches the database", async () => {
    delete process.env.RUN_MIGRATIONS;

    // `db:migrate` runs behind the operator guard, which has already resolved
    // and printed the target by this point — so the authority is satisfied and
    // the call proceeds to connect. Against the preload's dead port that is a
    // connection error, and a connection error is the pass condition: it says
    // the authority check let it through.
    const err = await rejection(
      runMigrationsWithLock({ kind: "operator", target: "dev" }),
    );
    expect(err.message).toContain("ECONNREFUSED");
  });
});
