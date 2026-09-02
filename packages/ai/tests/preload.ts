/**
 * Test preload — runs before every test file evaluates, registered via
 * `bunfig.toml` (`[test] preload = "./tests/preload.ts"`).
 *
 * Under `--isolate` it runs ONCE PER FILE, in that file's own global and
 * module registry, which is what makes it a setup step rather than a shared
 * mutable state. It has two jobs, in this order:
 *
 *   1. `./lib/test-env`   — the env wall (what a unit test may see, and what
 *                           it may not: no Langfuse, no live database).
 *   2. `./lib/test-doubles` — the module doubles every file gets (redis, team
 *                           AI settings, the live model snapshot).
 *
 * Both are imports rather than inline code because the ORDER matters and a
 * module's body waits for its own dependencies: env before any real module
 * loads, redis before anything that reaches it.
 *
 * What CANNOT be a static import is anything that must OBSERVE those doubles —
 * see `installBoundFleet` below. Registering a mock is a runtime act, and ESM
 * gives a module no way to say "link me after that call ran": siblings of an
 * async dependency are evaluated concurrently, so a second `import` here would
 * link its graph — the real `lib/redis` included — while `./lib/test-doubles`
 * was still awaiting. Measured, not theorised: 14 tests then died on ioredis
 * reconnect backoff instead of asserting.
 *
 * Three things this file used to do and no longer needs to, all of them
 * single-process artifacts removed with `--isolate`:
 *   - capture the real `@fretik/shared/db` exports so a mocking file could put
 *     them back in `afterAll` (there is no later file to protect);
 *   - re-install the fleet and the team-settings double from a global
 *     `beforeEach`, because suites that drove `setLiveStateDouble` left the
 *     snapshot as their last test set it and bun's `readdir` order decided who
 *     paid (a suite that mutates now only affects itself, and installs its own
 *     `beforeEach` if it wants a per-test baseline);
 *   - explain which file must load first.
 */

import "./lib/test-doubles";

// The snapshot starts POPULATED, with rows for the models `ROLE_BINDINGS`
// names.
//
// It used to start empty, which was exactly what the real module answered on a
// cold process — and harmless, because a curated TypeScript registry could
// resolve a role without a database. That registry is gone: the rows ARE the
// registry, so an empty snapshot now means "this process knows of no models at
// all", and every test whose fixture resolves a model (`modelProfile:
// getProfileForRole("chat")` in a runtime context, say) would fail on a
// condition it is not testing.
//
// A test that wants the cold case asks for it — `setLiveStateDouble()` with no
// argument — and several do.
//
// Dynamically imported on purpose (see the header): `live-fleet` reaches
// `src/lib/model-registry/effective`, whose graph imports `lib/redis`, and it
// must therefore link AFTER the doubles above are registered.
const { installBoundFleet } = await import("./lib/live-fleet");

installBoundFleet();

// The Redis half of the env wall — integration only, and last, because it is
// the one check that has to OPEN a connection to make its claim. See
// `lib/test-env.ts` for what it looks for and the afternoon that put it there.
if (process.env.INTEGRATION_DB === "1") {
  const { assertDisposableRedis } = await import("./lib/test-env");
  await assertDisposableRedis();
}
