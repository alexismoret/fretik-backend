/**
 * Test preload — runs ONCE before any test file evaluates, registered via
 * `bunfig.toml` (`[test] preload = "./tests/preload.ts"`). Same file, same
 * rationale, as `@fretik/ai/tests/preload.ts`; this package simply never
 * adopted it.
 *
 * Several modules here validate their env vars at top level (`throw "Missing
 * X"`) so a misconfigured service fails to boot loudly rather than at the
 * first request. That fail-fast is deliberate and stays. Its side effect is
 * that a unit test crashes at module LOAD — before a single assertion runs —
 * merely for importing a file that also happens to contain, say, a database
 * query it never calls.
 *
 * Worse, `bun test` shares one process: whichever file reaches the real
 * `src/db` first poisons the module cache for every other file, which is why
 * eight otherwise self-defending tests failed only in the batch run.
 *
 * These are env stubs, not mocks: every test keeps its real fixtures and its
 * real assertions. `??=` means real CI secrets, when wired, always win. None
 * of the values is usable for an actual call — the ports are `:1` on
 * purpose — and nothing connects: `runMigrationsWithLock()` is gated on
 * `NODE_ENV !== "test"` inside `db/index.ts`, and both `drizzle()` and the pg
 * pool are lazy. Anything that genuinely needs a live database, Redis or S3
 * is an integration test and brings its own credentials.
 */

// Postgres — `src/db/index.ts` checks presence at load; the migration call
// below it is skipped under `bun test`, so no socket is ever opened.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";

// Redis — `src/lib/redis.ts` and `src/lib/queue/connection.ts`.
process.env.REDIS_URL ??= "redis://127.0.0.1:1";

// Scaleway S3 — `src/lib/s3.ts` requires all five together.
process.env.S3_BUCKET ??= "test-bucket";
process.env.S3_URL ??= "http://127.0.0.1:1";
process.env.S3_REGION ??= "fr-par";
process.env.SCW_ACCESS_KEY ??= "test-access";
process.env.SCW_SECRET_KEY ??= "test-secret";

// Transactional email — `src/lib/email.ts` requires all five together
// (`SCW_SECRET_KEY` is shared with S3 above).
process.env.SCW_PROJECT_ID ??= "test-project";
process.env.SCW_EMAIL_REGION ??= "fr-par";
process.env.EMAIL_FROM_NAME ??= "Test";
process.env.EMAIL_FROM_ADDRESS ??= "test@example.com";

// Reached through `src/lib/auth.ts` and `src/lib/ai-service.ts`.
process.env.APP_URL ??= "http://127.0.0.1:1";
process.env.AI_SERVICE_URL ??= "http://127.0.0.1:1";
process.env.INTERNAL_KEY ??= "test-internal";
process.env.MISTRAL_API_KEY ??= "test-mistral";
