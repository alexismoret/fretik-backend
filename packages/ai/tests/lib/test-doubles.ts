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
 * What is NOT here any more: the restoration hooks. Under `--isolate` each
 * test file gets a fresh module registry, so a mock a file installs dies with
 * that file and cannot reach the next one. Restoring a module in `afterAll`,
 * or re-installing a double in a global `beforeEach`, was a single-process
 * artifact — see `tests/preload.ts`.
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
