/**
 * The env a unit test is allowed to see — a WALL, not a set of defaults.
 *
 * Several modules in @fretik/ai and @fretik/shared validate their env vars at
 * top level (`throw "Missing X env"`) so a misconfigured service fails to boot
 * loudly rather than at the first request. That fail-fast is deliberate and
 * stays; its side effect is that a unit test crashes at module LOAD, before a
 * single assertion runs, merely for importing a file that also happens to
 * contain a query it never calls.
 *
 * These used to be `??=`, so a real value always won. That is what made the
 * suite dishonest: on a developer machine Bun side-loads `.env`, so the unit
 * run reached the real Redis, the real Langfuse project and, in principle, a
 * real database — while CI, with no `.env`, ran against nothing. Two different
 * suites wearing one name, and the difference only ever showed up as a CI-only
 * failure.
 *
 * So a unit run gets these values and no others (`=`). None of them is usable
 * for a real call — the ports are `:1` on purpose. Anything that genuinely
 * needs a live database, Redis or S3 is an INTEGRATION test: it sets
 * `INTEGRATION_DB=1`, which lifts the wall and lets the caller's environment
 * through untouched (`??=`, so a var the caller did not set still gets a
 * placeholder rather than crashing an unrelated import).
 *
 * A FUNCTION, called from the body of `test-doubles.ts`, and not a bare
 * `import` with the assignments at top level: `prettier-plugin-organize-imports`
 * relocates a side-effect import inside the import block, so its position — and
 * with it "the env is set before anything else evaluates" — is not something
 * the source can promise. A call in a module body is.
 */

/**
 * Databases an integration run may touch.
 *
 * A NAME pattern, not a host allowlist: the SSH tunnel makes production look
 * exactly like `127.0.0.1:5434`, so no hostname, port or `NODE_ENV` can tell
 * the two apart — the incident of 2026-08-30 was precisely a laptop pointed at
 * that tunnel. What cannot be disguised is the database's own name. (The
 * disposable database in fact lives on the production HOST, which is exactly
 * why the host is not what gets checked.)
 *
 * The marker must be a whole word at one END: `test-fretik` and `fretik_test`
 * qualify, `fretik` does not.
 */
const SAFE_DB_NAME_PATTERN = /^(test|ci)[-_]|[-_](test|ci)$/;

/**
 * Refuse to run integration tests against anything but a disposable database.
 *
 * Lives here rather than in each of the integration files because "the suite
 * lifted the env wall" and "the suite may write to this database" are the same
 * decision: a file that forgets to import a guard would still be covered, and
 * a unit file that never lifts the wall still gets the dead `:1` port.
 */
const assertDisposableDatabase = (): void => {
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
};

export const installTestEnv = (): void => {
  const integration = process.env.INTEGRATION_DB === "1";

  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `Test preload loaded with NODE_ENV="${process.env.NODE_ENV ?? ""}" — expected "test". Run the suite through \`bun test\`, which sets it.`,
    );
  }

  /** Integration brings its own credentials; a unit run gets these and no others. */
  const set = (key: string, value: string): void => {
    if (integration) process.env[key] ??= value;
    else process.env[key] = value;
  };

  // OpenRouter — src/lib/openrouter.ts, src/lib/embeddings.ts,
  // src/services/search/reranker.ts
  set("OPENROUTER_API_KEY", "test-openrouter");
  set("OPENROUTER_CHAT_MODEL", "test/chat");
  set("OPENROUTER_FALLBACK_MODEL", "test/chat-fallback");
  set("OPENROUTER_PREEXTRACT_MODEL", "test/preextract");
  set("OPENROUTER_PREEXTRACT_FALLBACK_MODEL", "test/preextract-fallback");
  set("OPENROUTER_EMBEDDING_MODEL", "test/embedding");
  set("OPENROUTER_RERANK_MODEL", "test/rerank");

  // Scaleway S3 — @fretik/shared/lib/s3
  set("SCW_ACCESS_KEY", "test-access");
  set("SCW_SECRET_KEY", "test-secret");
  set("S3_BUCKET", "test-bucket");
  set("S3_URL", "http://127.0.0.1:1");
  set("S3_REGION", "fr-par");

  // Redis / E2B / Mistral / internal auth — transitively imported by some SUTs
  // even when the test path doesn't touch the wire.
  set("REDIS_URL", "redis://127.0.0.1:1");
  set("E2B_API_KEY", "test-e2b");
  set("MISTRAL_API_KEY", "test-mistral");
  set("TAVILY_API_KEY", "test-tavily"); // src/lib/tavily.ts validates at load
  set("INTERNAL_KEY", "test-internal");
  set("AI_SERVICE_URL", "http://127.0.0.1:1");
  set("APP_URL", "http://127.0.0.1:1");

  // Transactional email — @fretik/shared/lib/email validates at load
  // (SCW_SECRET_KEY is set above). Reachable from unit tests via
  // tools/manage-workflow → shared/services/workflows/create-run →
  // send-run-completion-email. `sendEmail` is a plain fetch called on demand,
  // so these values never cause a network call.
  set("SCW_PROJECT_ID", "test-project");
  set("SCW_EMAIL_REGION", "fr-par");
  set("EMAIL_FROM_NAME", "Test");
  set("EMAIL_FROM_ADDRESS", "test@example.com");

  // Postgres — `@fretik/shared/db` validates this at module load. Nothing in a
  // unit test may reach a database, so the port is dead: a file that opens a
  // connection fails with `ECONNREFUSED 127.0.0.1:1` and names itself, instead
  // of quietly reading (or writing) whatever `.env` pointed at.
  set("DATABASE_URL", "postgres://test:test@127.0.0.1:1/test");

  // SQL tool read-only role — src/lib/db-readonly.ts throws at module load
  // when this is absent (C10 hardening). Same dead port, same reason.
  set("AI_DB_READONLY_URL", "postgres://test:test@127.0.0.1:1/test");

  // Langfuse — `src/lib/langfuse.ts` starts tracing as soon as all three are
  // present, so a local unit run was posting observations to the real project
  // (`[langfuse] tracing enabled — host=…` in the output was the tell). Unit
  // tests assert on what the code does, never on what a SaaS recorded.
  //
  // EMPTIED, NOT DELETED, and that distinction is load-bearing: `chromiumly`
  // (pulled in by `services/documents/convert`, which a dozen unit tests reach
  // transitively) calls `dotenv.config()` AT IMPORT, re-reading `.env` from the
  // process CWD. `dotenv` never overwrites a key that already exists — but a
  // deleted key does not exist, so `delete` was quietly undone the moment any
  // test touched that graph, and the run went back to tracing to production.
  // An empty string is present, therefore untouchable, and still falsy.
  //
  // BOTH families, since 2026-09-02. This used to fire only for unit tests, on
  // the reasoning that an integration run "brings its own credentials" — but
  // the credentials it brings are `.env`'s, which are the production project's,
  // and `??=` handed them over without anyone choosing to. So a laptop's
  // `test:integration` posted observations to the real Langfuse under the
  // developer's own keys, printing the same `[langfuse] tracing enabled —
  // host=…` tell the comment above calls out. CI never noticed: it has no
  // Langfuse secrets, so the one environment where this was visible was the
  // one nobody watches. No integration test reads Langfuse; the evals, which
  // do, are not `bun test` and set their own.
  process.env.LANGFUSE_PUBLIC_KEY = "";
  process.env.LANGFUSE_SECRET_KEY = "";
  process.env.LANGFUSE_BASE_URL = "";

  if (!integration) return;

  assertDisposableDatabase();
};

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
 * Added 2026-09-02 after this suite spent an afternoon writing into a
 * DEVELOPER'S OWN Redis without anyone noticing. `docker run -p 6379:6379` had
 * appeared to work, but a native `redis-server` already held `127.0.0.1:6379`
 * on the loopback address specifically while Docker bound the wildcard — so
 * `redis://127.0.0.1:6379` reached the dev instance, full of real keys.
 * `@fretik/jobs` refused on the first try, because it already had this check;
 * this package did not have it, and said nothing.
 *
 * Separate from `installTestEnv` because it is ASYNC, and it opens its OWN
 * connection rather than borrowing `@fretik/shared/lib/redis`: this package's
 * preload replaces that module with `redis-double` before any test file runs,
 * so asking it for the marker key asks the double, which answers `null` to
 * everything and would refuse every instance including the right one. The
 * question here is about the SERVER, so it has to be put to the server.
 */
export const assertDisposableRedis = async (): Promise<void> => {
  const url = process.env.REDIS_URL;
  if (url === undefined) {
    throw new Error(
      "INTEGRATION_DB=1 without a REDIS_URL. Point it at a disposable Redis carrying the `fretik:disposable` marker key.",
    );
  }
  const { default: Redis } = await import("ioredis");
  const client = new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    await client.connect();
    if ((await client.get("fretik:disposable")) === null) {
      throw new Error(
        `Refusing to run integration tests against the Redis at ${new URL(url).host}: no \`fretik:disposable\` key. These tests WRITE. Set the key on the throwaway instance to opt it in.`,
      );
    }
  } finally {
    client.disconnect();
  }
};
