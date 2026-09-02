/**
 * Two locks before an integration test may touch a live Postgres or Redis.
 *
 * Postgres is checked the way `packages/shared/tests/preload.ts` checks it: by
 * the database's own NAME, read from the URL and required to carry a `test` or
 * `ci` marker at one end. Not the host, not the port, not `NODE_ENV` — the
 * incident of 2026-08-30 was a laptop pointed at an SSH tunnel, through which
 * production looks exactly like `127.0.0.1:5434`. The disposable database in
 * fact lives on the production HOST, which is precisely why the host is not
 * what gets checked.
 *
 * Redis has no equivalent of `current_database()`: an instance cannot tell you
 * its own name, and a tunnel disguises everything else. So the marker is a KEY
 * an operator sets once on the disposable instance:
 *
 *     SET fretik:disposable "<why this instance is disposable>"
 *
 * Production does not have it, and a tunnel cannot forge it — reaching the key
 * means reaching the instance somebody deliberately marked as throwaway. The
 * suite obliterates whole BullMQ queues, so nothing weaker would do.
 */

const SAFE_DB_NAME_PATTERN = /^(test|ci)[-_]|[-_](test|ci)$/;

/** The key an operator sets, once, on a Redis that may be wiped. */
export const DISPOSABLE_MARKER_KEY = "fretik:disposable";

export const assertDisposableDatabase = (): void => {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error(
      "INTEGRATION_DB=1 without a DATABASE_URL. Point it at a disposable database whose name carries a `test` or `ci` marker.",
    );
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!SAFE_DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": the name must start or end with test/ci. These tests CREATE AND DELETE rows.`,
    );
  }
};

/**
 * The Redis half, on the client the code under test already uses.
 *
 * Kept out of `tests/preload.ts` on purpose: `@fretik/shared/lib/redis`
 * connects when it is imported, so a unit run that loaded this would dial the
 * preload's dead port on every file. Integration suites call it from
 * `beforeAll`, where a connection is the point.
 */
export const assertDisposableRedis = async (client: {
  get: (key: string) => Promise<string | null>;
}): Promise<void> => {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error(
      "INTEGRATION_DB=1 without a REDIS_URL. Point it at a disposable Redis carrying the `fretik:disposable` marker key.",
    );
  }
  if ((await client.get(DISPOSABLE_MARKER_KEY)) === null) {
    throw new Error(
      `Refusing to run integration tests against ${new URL(url).host}: no \`${DISPOSABLE_MARKER_KEY}\` key. These tests OBLITERATE queues. Set the key on the throwaway instance to opt it in.`,
    );
  }
};
