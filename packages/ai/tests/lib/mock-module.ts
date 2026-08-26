import { mock } from "bun:test";

/**
 * Replace a module for the rest of the run, KEEPING every export it already
 * has. Sibling of `@fretik/shared/tests/unit/mock-module.ts`; same hazard,
 * same fix.
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
 * is exactly how `isCacheableValue` broke `@fretik/shared`'s CI run while
 * every local run stayed green. This package had the same shape in at least a
 * dozen factories; nothing imported the dropped names yet, so it was green by
 * luck rather than by construction.
 *
 * A note for whoever probes this in isolation and finds the spread "missing"
 * an export: Bun tree-shakes exports that NOTHING in the graph imports, so a
 * one-file scratch test shows a shorter namespace than the suite does. That is
 * harmless, and it is the invariant that makes this work — an export somebody
 * imports is, by definition, in the graph and therefore in the spread.
 *
 * FIRST-PARTY AND WORKSPACE MODULES ONLY (`../../src/…`, `@fretik/shared/…`).
 * On a third-party package the pre-import wins and the override never takes
 * effect; use a plain `mock.module` there, as `@fretik/shared`'s
 * `mcp-client.test.ts` does.
 */

/** `packages/ai/` — this file lives at `tests/lib/`. */
const PACKAGE_ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Test files here sit at three different depths (`tests/`, `tests/lib/`,
 * `tests/unit/tools/`), so the same module is written `../../src/x` in one and
 * `../../../src/x` in another. Both are anchored back to the package root, so
 * a caller keeps writing the specifier its own imports use.
 *
 * Relative specifiers must therefore point INSIDE `src/` — the only ones any
 * caller mocks. Anything else (a bare package name) is passed through.
 */
const resolveSpecifier = (specifier: string): string =>
  specifier.startsWith(".")
    ? PACKAGE_ROOT + specifier.replace(/^(?:\.{1,2}\/)+/, "")
    : specifier;

export const mockModule = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const resolved = resolveSpecifier(specifier);
  const actual: Record<string, unknown> = await import(resolved);
  void mock.module(resolved, () => ({ ...actual, ...overrides }));
};

/**
 * Load the real namespace of `specifier` so a SYNCHRONOUS caller can spread it
 * later. `installSandboxMocks()` is deliberately not async: a test file that
 * forgot the `await` would register its mocks after the SUT import and lose
 * the race silently — the exact class of order-dependent bug this file exists
 * to remove.
 */
export const loadRealModule = async (
  specifier: string,
): Promise<Record<string, unknown>> => import(resolveSpecifier(specifier));

/**
 * Spread `actual` under `overrides`, but turn every FUNCTION the caller did
 * not override into one that throws by name.
 *
 * For an I/O boundary — E2B, S3, the database — a plain spread would be a
 * downgrade: a helper the fixture forgot to stub would silently fall through
 * to the real implementation and a unit test would quietly dial a sandbox.
 * Before, that omission at least failed loudly (`Export named … not found`),
 * just in the wrong file. This keeps both properties: the export still EXISTS,
 * so no unrelated suite dies at link time, and calling it fails immediately
 * with a message naming what to stub. Non-function exports (constants, enums)
 * keep their real values — those are facts, not I/O.
 *
 * Same reasoning as `redis-double.ts`'s `notImplemented(name)`: a silent
 * `undefined` turns an assertion into a lie that passes.
 */
/**
 * `mockModule` for an EXTERNAL-RESOURCE boundary — S3, E2B, the database, the
 * extraction pipeline. Anything the factory does not override still exists,
 * but calling it throws instead of reaching the real thing. Use this wherever
 * a fall-through would mean a unit test opening a socket; use `mockModule` for
 * pure or in-process modules, where keeping the real implementation is the
 * point.
 */
export const mockModuleStrict = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const resolved = resolveSpecifier(specifier);
  const actual: Record<string, unknown> = await import(resolved);
  void mock.module(resolved, () =>
    strictOverrides(specifier, actual, overrides),
  );
};

export const strictOverrides = (
  moduleName: string,
  actual: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...overrides };
  for (const [name, value] of Object.entries(actual)) {
    if (name in overrides) continue;
    result[name] =
      typeof value === "function"
        ? () => {
            throw new Error(
              `${moduleName}.${name} is not stubbed — a unit test must not reach the real implementation. Add it to the fixture.`,
            );
          }
        : value;
  }
  return result;
};
