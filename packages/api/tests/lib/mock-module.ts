import { mock } from "bun:test";

/**
 * Replace a module for the rest of the file, KEEPING every export it already
 * has.
 *
 * `mock.module` swaps a module in the registry wholesale, so a factory that
 * hand-lists the exports a suite needs DELETES the others — and the file that
 * pays is any module in the graph importing a name the factory never mentioned.
 * It fails at link time (`SyntaxError: Export named 'x' not found`), taking the
 * whole file down: its tests are not failed, they are never registered.
 * Spreading the real module makes that impossible.
 *
 * Anything imported STATICALLY by the test file is evaluated before the first
 * line of its body, so a module that must see the fake has to be reached
 * through `await import(...)` after the call — not through a top-level import.
 */
export const mockModule = async (
  specifier: string,
  overrides: Record<string, unknown>,
): Promise<void> => {
  const actual: Record<string, unknown> = await import(specifier);
  void mock.module(specifier, () => ({ ...actual, ...overrides }));
};
