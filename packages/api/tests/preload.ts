/**
 * Test preload — the env a unit test in this package is allowed to see. A WALL,
 * not a set of defaults. Registered from `bunfig.toml`; under `--isolate` it
 * runs once per test file, in that file's own global.
 *
 * It exists because `packages/api/.env` is real, and Bun side-loads it. Without
 * this file, importing a handler — which reaches Better Auth, the database
 * handle, Redis and S3 — would run the suite against the developer's actual
 * services: green locally, red in CI, and writing to something on the way.
 * Every value below points at port 1, so a module that opens a connection fails
 * with `ECONNREFUSED 127.0.0.1:1` and names itself.
 *
 * The auth boundary is testable under this wall precisely because an
 * unauthenticated request is answered before any I/O: no cookie means no
 * session lookup, and the 401 comes back without a database.
 */

if (process.env.NODE_ENV !== "test") {
  throw new Error(
    `Test preload loaded with NODE_ENV="${process.env.NODE_ENV ?? ""}" — expected "test". Run the suite through \`bun test\`, which sets it.`,
  );
}

const set = (key: string, value: string): void => {
  process.env[key] = value;
};

set("DATABASE_URL", "postgres://test:test@127.0.0.1:1/test");
set("REDIS_URL", "redis://127.0.0.1:1");

// `@fretik/shared/lib/s3` and `lib/email` validate their whole set at load.
set("S3_BUCKET", "test-bucket");
set("S3_URL", "http://127.0.0.1:1");
set("S3_REGION", "fr-par");
set("SCW_ACCESS_KEY", "test-access");
set("SCW_SECRET_KEY", "test-secret");
set("SCW_PROJECT_ID", "test-project");
set("SCW_EMAIL_REGION", "fr-par");
set("EMAIL_FROM_NAME", "Test");
set("EMAIL_FROM_ADDRESS", "test@example.com");

// Better Auth, the AI service and the sandbox JWT.
set("APP_URL", "http://127.0.0.1:1");
set("AI_SERVICE_URL", "http://127.0.0.1:1");
set("INTERNAL_KEY", "test-internal");
set("BETTER_AUTH_SECRET", "test-secret-not-a-real-one");
set("MISTRAL_API_KEY", "test-mistral");
