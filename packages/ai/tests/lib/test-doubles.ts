/**
 * The module doubles every unit test file gets, installed before any of them
 * loads.
 *
 * Order is load-bearing, and it is expressed by STATEMENTS, never by the order
 * of the import list — `prettier-plugin-organize-imports` rewrites that, a
 * bare side-effect import included. Hence `installTestEnv()` as a call: the
 * env wall must be up before any REAL module loads, and every real module here
 * loads inside a `mockModule` call below. The imports above are inert (types,
 * `bun:test`, and doubles with no dependencies of their own).
 *
 * The redis double must be registered before `mockModule` pulls in a module
 * that reaches `lib/redis` — again a statement ordering, not an import one.
 *
 * A NOTE ON RESTORATION, which this header used to get wrong. It said a mock
 * a file installs "dies with that file and cannot reach the next one" under
 * `--isolate`. That is true of the modules a file IMPORTS and false of a
 * `mock.module` REGISTRATION, which is process-wide and permanent — the same
 * correction `tests/preload.ts` already carries for `installBoundFleet()`.
 *
 * Restoring in `afterAll` does not fix it either, because a test file's body
 * runs when bun EVALUATES the file, not when its tests run, and the walk order
 * is not stable: measured on this commit, one identical two-file command
 * alternated between 34/34 and 25/34. So a mock whose behaviour would be wrong
 * for another file belongs HERE, registered once, with the per-test state that
 * drives it in its own double — `team-ai-settings-double.ts` and
 * `resolve-model-double.ts` are the two worked examples.
 */

import { mock } from "bun:test";
import { getLiveSnapshotSync, getLiveStateSync } from "./live-state-double";
import { mockModule } from "./mock-module";
import { redisDouble } from "./redis-double";
import { getTeamAiSettings } from "./team-ai-settings-double";
import { installTestEnv } from "./test-env";

installTestEnv();

// The singleton is imported by dozens of modules, so the first module to load
// it wins the file's registry and a per-file mock loses the race. With a dead
// port ioredis does not fail, it RETRIES: the page-review budget tests died on
// the 5 s timeout instead of asserting. The double is in-memory and throws by
// name on any command it does not implement.
//
// This is the ONE mock here that is hand-listed rather than spread over the
// real module (`tests/lib/mock-module.ts`): spreading would have to IMPORT
// `lib/redis`, and constructing the real ioredis client is precisely what the
// double exists to prevent. The price is that this list must be kept in step
// with the module's exports by hand — `mock.module` replaces a module WHOLE,
// so a name missing here stops existing for every importer in this file's
// graph and kills it at LINK time. `isCacheableValue` is exactly how that bit
// `@fretik/shared` in CI; it is re-declared below rather than imported.
void mock.module("@fretik/shared/lib/redis", () => ({
  redis: redisDouble,
  // Same argument order as the real helper (`fn` FIRST, then key, then ttl).
  // The previous stub took them as `(key, ttl, fetcher)`, so any caller using
  // the real signature would have invoked a number as the fetcher. Nothing in
  // the unit suite reaches it today, which is why it went unnoticed.
  selectOrCache: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  isCacheableValue: (value: unknown): boolean =>
    value !== null && value !== undefined,
  deleteKeysByPrefix: (): Promise<void> => Promise.resolve(),
}));

// `resolveModelForTeam` / `cheapModelIdForTeam` (src/lib/model-registry/
// team-model.ts) are reachable from many unrelated unit tests (memory
// services, compaction, search, pre-extract, the full chatbot agent set), and
// a file that reaches that chain through a transitive import has no obvious
// place to install the double itself. Registering it here makes it a property
// of the suite rather than of each file's import graph — see
// tests/lib/team-ai-settings-double.ts for the mutable per-test state.
//
// Registered AFTER the redis mock on purpose: `mockModule` imports the real
// module to carry its other exports, and this one reaches `lib/redis` — which
// must already be the double by then.
await mockModule("@fretik/shared/services/team-ai-settings/get-for-team", {
  getTeamAiSettings,
});

// Same reasoning, same shape: `model-registry/resolve.ts` reads the live
// snapshot and half the suite imports it transitively, so the readers are
// doubled here rather than per file.
await mockModule("@fretik/shared/services/model-registry/live", {
  getLiveStateSync,
  getLiveSnapshotSync,
});

// `resolveModel` itself, wrapped so ONE suite can assert a code path never
// reaches a model without arming that assertion for the whole run. Disarmed
// — which is every file but `repair-tool-call.test.ts`, and every test in it
// that has not armed it — this delegates to the real implementation.
//
// Registered here for the reason the header gives and the reason
// `resolve-model-double.ts` measures: a file-scoped `mock.module` on this
// path is permanent and process-wide, so whichever file installs one decides
// what every later file sees.
//
// DYNAMICALLY imported, and last, because unlike the doubles in the import
// list above this one is not inert: it loads the real `resolve.ts` in order
// to delegate to it, and that module reads the live snapshot and reaches
// `lib/redis`. A static import would hoist it ahead of `installTestEnv()`
// and ahead of both mocks above — the exact ordering trap this file's header
// describes.
const { resolveModel: resolveModelDouble } =
  await import("./resolve-model-double");

await mockModule("../../src/lib/model-registry/resolve", {
  resolveModel: resolveModelDouble,
});

// The decision engine answers nothing in a unit test. The memory passes, the
// relation writer and the chat's continuation check all reach it in-process,
// some fire-and-forget, and none of them may reach the decision provider from
// a test that never meant to. `null` is every caller's "no answer" branch —
// the path each point replaced — so a suite not about a point sees exactly
// what it saw before the point existed. A suite ABOUT a point passes its own
// evaluator; the engine's suite imports `decide-point`, which stays real.
await mockModule("../../src/services/decisions/in-process", {
  inProcessEvaluator: () => Promise.resolve(null),
});
