/**
 * Test preload — the env a unit test in this package is allowed to see. A WALL,
 * not a set of defaults. Registered from `bunfig.toml`; under `--isolate` it
 * runs once per test file, in that file's own global.
 *
 * It exists because `packages/jobs/.env` is real. Bun side-loads it, so without
 * this file a test that transitively imports a queue, the database handle or
 * the AI client would run against the developer's actual Redis and Postgres —
 * passing locally, failing in CI, and writing to something on the way. Every
 * value below points at port 1: a module that opens a connection fails with
 * `ECONNREFUSED 127.0.0.1:1` and names itself, instead of quietly working.
 *
 * `INTEGRATION_DB=1` lifts the wall and lets the caller's own Postgres and Redis
 * through (`??=`, so a variable the caller did not supply still gets a
 * placeholder rather than crashing an unrelated import). Two locks stand behind
 * the flag — see `tests/lib/integration-guard.ts`: the database's own name, and
 * a marker key on the Redis.
 */

import { assertDisposableDatabase } from "./lib/integration-guard";

if (process.env.NODE_ENV !== "test") {
  throw new Error(
    `Test preload loaded with NODE_ENV="${process.env.NODE_ENV ?? ""}" — expected "test". Run the suite through \`bun test\`, which sets it.`,
  );
}

const integration = process.env.INTEGRATION_DB === "1";

if (integration) assertDisposableDatabase();

/** Integration brings its own credentials; a unit run is given these and no others. */
const set = (key: string, value: string): void => {
  if (integration) process.env[key] ??= value;
  else process.env[key] = value;
};

// Postgres — `@fretik/shared/db` checks presence at load.
set("DATABASE_URL", "postgres://test:test@127.0.0.1:1/test");

// Redis — BullMQ's producer/worker connections and the debounce keys.
set("REDIS_URL", "redis://127.0.0.1:1");

// Scaleway S3 + transactional email — `lib/s3` and `lib/email` require their
// whole set together and throw at module load when one is missing.
set("S3_BUCKET", "test-bucket");
set("S3_URL", "http://127.0.0.1:1");
set("S3_REGION", "fr-par");
set("SCW_ACCESS_KEY", "test-access");
set("SCW_SECRET_KEY", "test-secret");
set("SCW_PROJECT_ID", "test-project");
set("SCW_EMAIL_REGION", "fr-par");
set("EMAIL_FROM_NAME", "Test");
set("EMAIL_FROM_ADDRESS", "test@example.com");

// The AI service and the app, reached from the memory workers.
set("APP_URL", "http://127.0.0.1:1");
set("AI_SERVICE_URL", "http://127.0.0.1:1");
set("INTERNAL_KEY", "test-internal");
