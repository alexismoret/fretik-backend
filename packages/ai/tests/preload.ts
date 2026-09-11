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
 * Two things this file used to do and no longer needs to, both of them
 * single-process artifacts removed with `--isolate`:
 *   - capture the real `@fretik/shared/db` exports so a mocking file could put
 *     them back in `afterAll` (there is no later file to protect);
 *   - explain which file must load first.
 *
 * A THIRD was removed with them and should not have been: the global
 * `beforeEach` that re-installs the fleet. It was dropped on the reading that
 * "a suite that mutates now only affects itself", which is true of the modules
 * a file IMPORTS and false of a `mock.module` REGISTRATION — those are
 * process-wide, so every file reads the double through one shared module
 * instance whatever `--isolate` does. It is back, below, with the measurement
 * that brought it back.
 */

import { beforeEach } from "bun:test";
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

/**
 * And again before EVERY test, because the snapshot is process-wide and a
 * per-file installation is not enough to keep it that way.
 *
 * This hook was removed when `--isolate` arrived, on the reading that a suite
 * which mutates a double "now only affects itself". That reading is wrong, and
 * the same wrongness cost `external-apps/update-action-policies.test.ts` three
 * tests in September: `--isolate` gives each file its own registry for the
 * modules it IMPORTS, but a `mock.module` REGISTRATION is process-wide, so
 * every file resolves the double through whichever registration got there
 * first — one module instance, one `rows` map, shared by the whole run. The
 * `installBoundFleet()` above then populates a copy nothing reads.
 *
 * What that produced: `model-profiles-card.test.ts` ends each of its tests with
 * `setLiveStateDouble()` — go back to cold, a correct thing to want — and every
 * later file in the run resolved its models against that empty snapshot.
 * Measured on this commit, `bun test --isolate --seed=7 tests/unit`: 34 tests
 * across five unrelated suites failing on `No model profile for key
 * "deepseek-v4-flash"`, in code that never mentions a model. It needs THREE
 * files to show up — with two, the victim's own preload is the last writer and
 * wins — which is why it followed the seed and vanished under `--only`.
 *
 * `beforeEach` rather than `afterEach` on purpose: a test then starts from the
 * baseline whatever the previous one left behind, including a previous FILE,
 * and it cannot be undone by a suite's own `afterEach` running later. A test
 * that wants a different snapshot still sets one in its own body and wins.
 */
beforeEach(() => {
  installBoundFleet();
});

// The Redis half of the env wall — integration only, and last, because it is
// the one check that has to OPEN a connection to make its claim. See
// `lib/test-env.ts` for what it looks for and the afternoon that put it there.
if (process.env.INTEGRATION_DB === "1") {
  const { assertDisposableRedis } = await import("./lib/test-env");
  await assertDisposableRedis();
}
