/**
 * Test preload — the env a unit test is allowed to see. A WALL, not a set of
 * defaults. Registered via `bunfig.toml` (`[test] preload =
 * "./tests/preload.ts"`), and under `--isolate` it runs once per test file, in
 * that file's own global.
 *
 * Several modules here validate their env vars at top level (`throw "Missing
 * X"`) so a misconfigured service fails to boot loudly rather than at the
 * first request. That fail-fast is deliberate and stays. Its side effect is
 * that a unit test crashes at module LOAD — before a single assertion runs —
 * merely for importing a file that also happens to contain, say, a database
 * query it never calls.
 *
 * These used to be `??=`, so a real value always won. That is what made the
 * suite dishonest: Bun side-loads `.env`, so a developer's unit run reached
 * the real Redis and, in principle, a real database, while CI — with no `.env`
 * — ran against nothing. Two different suites wearing one name, and the gap
 * only ever surfaced as a CI-only failure. So a unit run gets these values and
 * no others (`=`), none of them usable: the ports are `:1` on purpose.
 *
 * Anything that genuinely needs a live database, Redis or S3 is an INTEGRATION
 * test: it sets `INTEGRATION_DB=1`, which lifts the wall and lets the caller's
 * environment through (`??=`, so a var the caller did not set still gets a
 * placeholder rather than crashing an unrelated import).
 *
 * One trap worth knowing before adding to this file: `chromiumly` — reached
 * through `services/documents/convert` — calls `dotenv.config()` AT IMPORT,
 * re-reading `.env` from the process CWD. It never overwrites a key that
 * exists, so an assignment here is safe; a `delete` is not, because a deleted
 * key does not exist and comes straight back. To disable something, set it to
 * an empty string.
 */

const integration = process.env.INTEGRATION_DB === "1";

if (process.env.NODE_ENV !== "test") {
  throw new Error(
    `Test preload loaded with NODE_ENV="${process.env.NODE_ENV ?? ""}" — expected "test". Run the suite through \`bun test\`, which sets it.`,
  );
}

/**
 * Databases an integration run may touch.
 *
 * A NAME pattern, not a host allowlist: the SSH tunnel makes production look
 * exactly like `127.0.0.1:5434`, so no hostname, port or `NODE_ENV` can tell
 * the two apart — the incident of 2026-08-30 was a laptop pointed at that
 * tunnel. What cannot be disguised is the database's own name. (The disposable
 * database in fact lives on the production HOST, which is precisely why the
 * host is not what gets checked.)
 *
 * The marker must be a whole word at one END: `test-fretik` and `fretik_test`
 * qualify, `fretik` does not.
 */
const SAFE_DB_NAME_PATTERN = /^(test|ci)[-_]|[-_](test|ci)$/;

if (integration) {
  const url = process.env.DATABASE_URL;
  if (url === undefined) {
    throw new Error(
      "INTEGRATION_DB=1 without a DATABASE_URL. Point it at a disposable database whose name ends in _test or _ci.",
    );
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!SAFE_DB_NAME_PATTERN.test(name)) {
    throw new Error(
      `Refusing to run integration tests against database "${name}": the name must end in _test or _ci. These tests CREATE AND DELETE rows.`,
    );
  }
}

/** Integration brings its own credentials; a unit run is given these and no others. */
const set = (key: string, value: string): void => {
  if (integration) process.env[key] ??= value;
  else process.env[key] = value;
};

// Postgres — `src/db/index.ts` checks presence at load. Nothing in a unit test
// may reach a database, so the port is dead: a file that opens a connection
// fails with `ECONNREFUSED 127.0.0.1:1` and names itself, instead of quietly
// reading (or writing) whatever `.env` pointed at.
set("DATABASE_URL", "postgres://test:test@127.0.0.1:1/test");

// Redis — `src/lib/redis.ts` and `src/lib/queue/connection.ts`.
set("REDIS_URL", "redis://127.0.0.1:1");

// Scaleway S3 — `src/lib/s3.ts` requires all five together.
set("S3_BUCKET", "test-bucket");
set("S3_URL", "http://127.0.0.1:1");
set("S3_REGION", "fr-par");
set("SCW_ACCESS_KEY", "test-access");
set("SCW_SECRET_KEY", "test-secret");

// Transactional email — `src/lib/email.ts` requires all five together
// (`SCW_SECRET_KEY` is shared with S3 above).
set("SCW_PROJECT_ID", "test-project");
set("SCW_EMAIL_REGION", "fr-par");
set("EMAIL_FROM_NAME", "Test");
set("EMAIL_FROM_ADDRESS", "test@example.com");

// Reached through `src/lib/auth.ts` and `src/lib/ai-service.ts`.
set("APP_URL", "http://127.0.0.1:1");
set("AI_SERVICE_URL", "http://127.0.0.1:1");
set("INTERNAL_KEY", "test-internal");
set("MISTRAL_API_KEY", "test-mistral");

/**
 * The REDIS half of the same wall, and it is not the same check.
 *
 * A Redis instance cannot report its own name — there is no `current_database()`
 * to ask, and the host tells you nothing (the disposable one and the real one
 * are both `127.0.0.1` behind a tunnel or a port map). So the marker is a KEY
 * an operator sets once, by hand, on an instance they are willing to lose:
 *
 *     SET fretik:disposable "<why this instance is disposable>"
 *
 * Added 2026-09-02 after this suite spent an afternoon writing cache entries
 * into a DEVELOPER'S OWN Redis without anyone noticing. `docker run -p
 * 6379:6379` had appeared to work, but a native `redis-server` already held
 * `127.0.0.1:6379` on the loopback address specifically while Docker bound the
 * wildcard — so `redis://127.0.0.1:6379` reached the dev instance, full of real
 * keys, and every integration run wrote to it. `@fretik/jobs` refused on the
 * first try, because it already had this check; shared and ai did not have it,
 * and said nothing. The damage was harmless (namespaced cache keys under random
 * uuids, no flush); the silence was not.
 *
 * Integration only, and imported lazily: `src/lib/redis` CONNECTS when it is
 * imported, so a unit run that loaded it here would dial the dead port on every
 * single file.
 */
if (integration) {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error(
      "INTEGRATION_DB=1 without a REDIS_URL. Point it at a disposable Redis carrying the `fretik:disposable` marker key.",
    );
  }
  const { redis } = await import("../src/lib/redis");
  if ((await redis.get("fretik:disposable")) === null) {
    throw new Error(
      `Refusing to run integration tests against the Redis at ${new URL(url).host}: no \`fretik:disposable\` key. These tests WRITE. Set the key on the throwaway instance to opt it in.`,
    );
  }
}
