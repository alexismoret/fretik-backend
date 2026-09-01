import { mock } from "bun:test";

/**
 * Replace a module for the rest of the run, KEEPING every export it already
 * has.
 *
 * `bun test` shares one process and `mock.module` is process-wide: it swaps a
 * module in the registry for every file, not just the one that called it. A
 * factory that hand-lists the two exports a suite happens to need therefore
 * DELETES the others — and the file that pays is some unrelated suite that
 * imports a name the factory never mentioned. It fails at link time, with
 * `SyntaxError: Export named 'x' not found`, which takes the whole file down:
 * its tests are not failed, they are never registered.
 *
 * The failure only appears in the orders where the mocking file runs first, so
 * it depends on `readdir` order — green on one filesystem, red on CI's. That
 * is how `isCacheableValue` (added to `lib/redis` long after the fakes were
 * written) and `buildRegistryUpdateBatch` broke a run that passed locally
 * every time.
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
 * SPREADING IS NOT ENOUGH WHEN TWO SUITES FAKE THE SAME MODULE.
 *
 * The hazard above is about a factory that DELETES exports. This one survives
 * it: mocks land while a file LOADS and tests run afterwards, so among the
 * suites here that fake `../../src/db` — there are ten — which fake a given
 * test sees depends on bun's load order. That is `readdir` order: alphabetical
 * on APFS, hash order on ext4.
 *
 * `model-registry-admin` and `model-registry-breaker` failed all 37 of their
 * tests on CI while passing locally in every order we could construct, so the
 * trigger was never reproduced — only its class. They now run in their own
 * process (`tests/isolated`, wired into the `test` script), which removes the
 * variable rather than betting on it.
 *
 * Two things learned the hard way, worth not repeating:
 *
 *  - **Do not re-install mocks from `beforeEach`.** `mock.module` does not take
 *    effect synchronously, so every test then reads the PREVIOUS test's
 *    fixtures — a clean off-by-one that looks like a logic bug.
 *  - A suite whose subject ANOTHER suite mocks cannot be fixed from inside
 *    itself: it captures its subject once, at its top-level `await import`,
 *    and whatever was installed at that instant is what it keeps.
 */
export const mockModule = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  // Resolved relative to THIS file, which is why it sits beside its callers:
  // every suite here addresses `src/` through the same `../../` prefix.
  const actual: Record<string, unknown> = await import(specifier);
  void mock.module(specifier, () => ({ ...actual, ...overrides }));
};
