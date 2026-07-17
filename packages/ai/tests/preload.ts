/**
 * Test preload — runs ONCE before any test file evaluates, registered
 * via `bunfig.toml` (`[test] preload = "./tests/preload.ts"`).
 *
 * Several modules in @fretik/ai and @fretik/shared validate their env
 * vars at top-level (`throw "Missing X env"`) so production boot fails
 * fast on misconfiguration. That fail-fast is intentional, but it also
 * means unit tests that only transitively import those modules (even
 * through code paths they never exercise) crash at module-load before
 * any assertion runs.
 *
 * This preload fills in dummy values ONLY when the real env var is
 * absent — `??=` ensures that when CI later wires real secrets, those
 * take precedence and the tests run against actual credentials. The
 * stubs are not valid for any external call; tests that hit real S3 /
 * OpenRouter / Redis live in `tests/integration/` and are gated by a
 * separate `test:integration` script.
 */

import { mock } from "bun:test";
import { getTeamAiSettings } from "./lib/team-ai-settings-double";

// OpenRouter — src/lib/openrouter.ts, src/lib/embeddings.ts,
// src/services/search/reranker.ts
process.env.OPENROUTER_API_KEY ??= "test-openrouter";
process.env.OPENROUTER_CHAT_MODEL ??= "test/chat";
process.env.OPENROUTER_FALLBACK_MODEL ??= "test/chat-fallback";
process.env.OPENROUTER_PREEXTRACT_MODEL ??= "test/preextract";
process.env.OPENROUTER_PREEXTRACT_FALLBACK_MODEL ??= "test/preextract-fallback";
process.env.OPENROUTER_EMBEDDING_MODEL ??= "test/embedding";
process.env.OPENROUTER_RERANK_MODEL ??= "test/rerank";

// Scaleway S3 — @fretik/shared/lib/s3
process.env.SCW_ACCESS_KEY ??= "test-access";
process.env.SCW_SECRET_KEY ??= "test-secret";
process.env.S3_BUCKET ??= "test-bucket";
process.env.S3_URL ??= "http://127.0.0.1:1";
process.env.S3_REGION ??= "fr-par";

// Redis / E2B / Mistral / internal auth — transitively imported by
// some SUTs even when the test path doesn't touch the wire.
process.env.REDIS_URL ??= "redis://127.0.0.1:1";
process.env.E2B_API_KEY ??= "test-e2b";
process.env.MISTRAL_API_KEY ??= "test-mistral";
process.env.TAVILY_API_KEY ??= "test-tavily"; // src/lib/tavily.ts validates at load
process.env.INTERNAL_KEY ??= "test-internal";
process.env.AI_SERVICE_URL ??= "http://127.0.0.1:1";
process.env.APP_URL ??= "http://127.0.0.1:1";

// Transactional email — @fretik/shared/lib/email validates at load
// (SCW_SECRET_KEY is already stubbed above). Reachable from unit tests via
// tools/manage-workflow → shared/services/workflows/create-run →
// send-run-completion-email. `sendEmail` is a plain fetch called on demand,
// so these stubs never cause a network call. Locally a .env side-load masks
// the gap; CI has no .env file and threw at email.ts load time.
process.env.SCW_PROJECT_ID ??= "test-project";
process.env.SCW_EMAIL_REGION ??= "fr-par";
process.env.EMAIL_FROM_NAME ??= "Test";
process.env.EMAIL_FROM_ADDRESS ??= "test@example.com";

// Postgres — `@fretik/shared/db` validates this env var at module
// load. The actual `runMigrationsWithLock()` call is gated on
// `NODE_ENV !== "test"` inside db/index.ts, so the fake URL below
// only needs to satisfy the presence check — no connection ever
// happens during unit tests.
process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:1/test";

// SQL tool read-only role — src/lib/db-readonly.ts throws at module load
// when this is absent (C10 hardening). The pg Pool is lazy, so the fake URL
// only satisfies the presence check; no connection happens in unit tests.
process.env.AI_DB_READONLY_URL ??= "postgres://test:test@127.0.0.1:1/test";

// `resolveModelForTeam` / `cheapModelIdForTeam` (src/lib/model-registry/
// team-model.ts) are reachable from many unrelated unit tests (memory
// services, compaction, search, pre-extract, the full chatbot agent set).
// Whichever test file imports that chain FIRST in this shared bun test
// process permanently binds team-model.ts's `getTeamAiSettings` reference —
// a mock.module() call from an individual test file only wins if nothing
// upstream already cached the real module, which is execution-order
// dependent (confirmed to differ between local runs and CI). Preloading
// this stub here, before any test file runs, makes it order-independent:
// see tests/lib/team-ai-settings-double.ts for the mutable per-test state.
void mock.module(
  "@fretik/shared/services/team-ai-settings/get-for-team",
  () => ({ getTeamAiSettings }),
);

// Capture the REAL `@fretik/shared/db` export values before any test
// file loads (and before any per-file db mock registers), so tests that
// mock the db can restore it for the rest of the process. Dynamic
// import — it must run AFTER the DATABASE_URL stub above.
await import("./lib/real-db");
