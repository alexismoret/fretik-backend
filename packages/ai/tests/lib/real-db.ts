/**
 * REAL `@fretik/shared/db` export values, captured from the test
 * preload BEFORE any test file evaluates (see tests/preload.ts).
 *
 * Two bun behaviours make an in-file capture impossible for a test
 * that mocks the db module:
 *   - `mock.module()` is hoisted above the rest of the mocking file,
 *     so `await import()` there already yields the fake;
 *   - a captured module NAMESPACE is a live view — bun re-patches its
 *     bindings when the mock registers, so even a preload-captured
 *     namespace turns fake. The spread below copies the VALUES into a
 *     plain object, which bun cannot patch.
 *
 * Tests that `mock.module("@fretik/shared/db", …)` MUST restore it in
 * `afterAll` (`mock.module("@fretik/shared/db", () => realDbExports)`)
 * — mocks are process-global, and without the restore every later test
 * file inherits the fake (integration db-fixtures then crash with
 * `db.insert is not a function`).
 */
export const realDbExports = { ...(await import("@fretik/shared/db")) };
