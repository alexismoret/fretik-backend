import { mock } from "bun:test";

/**
 * Replace a module for the rest of the run, KEEPING every export it already
 * has.
 *
 * `mock.module` swaps a module in the registry for the whole file, not just
 * for the importer that asked. A factory that hand-lists the two exports a
 * suite happens to need therefore DELETES the others — and the file that pays
 * is any module in THIS file's graph that imports a name the factory never
 * mentioned. It fails at link time, with `SyntaxError: Export named 'x' not
 * found`, which takes the whole file down: its tests are not failed, they are
 * never registered.
 *
 * `--isolate` gives every test file its own module registry, so the damage can
 * no longer cross files — but inside one file it is unchanged, and it still
 * strikes when a source module GAINS an export (that is how `isCacheableValue`,
 * added to `lib/redis` long after the fakes were written, and
 * `buildRegistryUpdateBatch` broke suites that never named them).
 *
 * Spreading the real module makes the whole class impossible: an export nobody
 * overrides keeps its real implementation, so adding one to a source file can
 * never again break a test that does not mention it. Overriding is still
 * explicit, and every fake stays as fake as it was.
 *
 * Loading the real module first is safe for `src/` — `tests/preload.ts` stubs
 * the env vars these modules validate at load, and none of them opens a socket
 * to do it.
 *
 * A note for whoever probes this in isolation and finds the spread "missing"
 * an export: Bun tree-shakes exports that NOTHING in the graph imports, so a
 * one-file scratch test shows a shorter namespace than the suite does. That is
 * harmless, and it is the invariant that makes this work — an export somebody
 * imports is, by definition, in the graph and therefore in the spread.
 *
 * FIRST-PARTY MODULES ONLY. On a node_modules package the pre-import wins and
 * the override never takes effect (see `mcp-client.test.ts`, which mocks
 * `@ai-sdk/mcp` with a plain `mock.module` for that reason). The hazard is
 * also smaller there: a dependency has one importer in `src/`, so a factory
 * that covers what that importer uses cannot starve anyone else.
 */
/**
 * Do NOT re-install mocks from `beforeEach`. `mock.module` does not take effect
 * synchronously, so every test then reads the PREVIOUS test's fixtures — a
 * clean off-by-one that looks like a logic bug.
 */
export const mockModule = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  // Resolved relative to THIS file, not the caller's — which is a trap for any
  // suite that does not sit exactly one level under `tests/`. Unit tests do
  // (`tests/unit/x.test.ts`, `../../src/…`); integration tests are grouped by
  // domain and sit two levels down, so their own correct `../../../src/…`
  // would resolve to `packages/src/…` here and fail to load.
  //
  // So every run of `../` is re-anchored at the package root: `../../src/db`
  // and `../../../src/db` both mean `packages/shared/src/db`, whoever wrote
  // them. A bare or scoped specifier (`ioredis`, `@fretik/shared/db`) has no
  // leading `../` and passes through untouched.
  const resolved = specifier.replace(/^(?:\.\.\/)+/, "../../");
  const actual: Record<string, unknown> = await import(resolved);
  void mock.module(resolved, () => ({ ...actual, ...overrides }));
};
