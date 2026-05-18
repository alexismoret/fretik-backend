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
process.env.INTERNAL_KEY ??= "test-internal";
process.env.AI_SERVICE_URL ??= "http://127.0.0.1:1";
process.env.APP_URL ??= "http://127.0.0.1:1";
