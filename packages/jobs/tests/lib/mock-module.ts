import { mock } from "bun:test";

/**
 * Replace a module for the rest of the file, KEEPING every export it already
 * has.
 *
 * `mock.module` swaps a module in the registry wholesale, so a factory that
 * hand-lists the two exports a suite needs DELETES the others — and the file
 * that pays is any module in the graph importing a name the factory never
 * mentioned. It fails at link time (`SyntaxError: Export named 'x' not found`),
 * which takes the whole file down: its tests are not failed, they are never
 * registered. Spreading the real module makes that impossible: an export nobody
 * overrides keeps its real implementation, so adding one to a source file can
 * never break a test that does not mention it.
 *
 * Under `--isolate` every test file has its own module registry, so a mock
 * cannot reach another file. It still must not be re-installed from
 * `beforeEach`: `mock.module` does not take effect synchronously, so each test
 * would read the PREVIOUS test's fixtures — a clean off-by-one that reads like
 * a logic bug.
 *
 * FIRST-PARTY MODULES ONLY. On a `node_modules` package the pre-import wins and
 * the override never takes effect; use a plain `mock.module` there.
 */
export const mockModule = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  // Resolved relative to THIS file, not the caller's. Every run of `../` is
  // re-anchored at the package root, so `../../src/x` from `tests/unit/` and
  // `../../../src/x` from a deeper folder both mean `packages/jobs/src/x`.
  const resolved = specifier.replace(/^(?:\.\.\/)+/, "../../");
  const actual: Record<string, unknown> = await import(resolved);
  void mock.module(resolved, () => ({ ...actual, ...overrides }));
};
