/**
 * `resolveModel` as a SPY with an armable tripwire, registered globally
 * from `tests/preload.ts` (NOT from an individual test file).
 *
 * Disarmed it delegates to the real function, so this is not a stand-in:
 * every suite that resolves a model goes on getting the real registry
 * answer, and the spy is only there for the one suite that asserts a code
 * path did or did not reach a model.
 *
 * WHY IT CANNOT BE A PER-FILE `mock.module`. `repair-tool-call.test.ts`
 * used to install its own throwing stub at module scope, which is how the
 * suite spent weeks being "flaky". `mock.module` is process-wide and
 * permanent, and a test file's module body runs when bun EVALUATES that
 * file, not when its tests run — so the tripwire was armed for every file
 * walked afterwards. An `afterAll` restore cannot fix it either, because
 * there is no stable order to restore in: measured on this commit, the
 * same two files passed 34/34 and failed 9/34 on alternate runs of one
 * identical command. The victims (`model-registry-team`, the page
 * builder's model, the critic pairing, `cheapModelIdForTeam`) all failed
 * on "the repair reached a model on an input it must refuse" — a message
 * from a suite they have nothing to do with.
 *
 * The fix is the one `team-ai-settings-double.ts` already documents for
 * the same class of problem: register the double ONCE for every file and
 * let the suite that cares drive it through mutable state. File order then
 * stops mattering, because there is only ever one registration.
 */
import { mock } from "bun:test";
import { loadRealModule } from "./mock-module";

type ResolveModel = (...args: never[]) => unknown;

const real = await loadRealModule("../../src/lib/model-registry/resolve");
const realResolveModel = real.resolveModel as ResolveModel;

let tripwire: string | null = null;

export const resolveModel = mock((...args: never[]): unknown => {
  if (tripwire !== null) throw new Error(tripwire);
  return realResolveModel(...args);
});

/**
 * Make the next call throw `message`, or pass `null` for the real thing.
 *
 * A suite asserting "this path must not reach a model" arms it so the
 * assertion holds even if the call count is right for the wrong reason.
 */
export const setResolveModelTripwire = (message: string | null): void => {
  tripwire = message;
};

/**
 * Back to the baseline: disarmed, and with no calls recorded.
 *
 * `tests/preload.ts` runs this before EVERY test, so a suite that arms the
 * tripwire cannot cost another file, and a suite counting calls cannot
 * inherit someone else's. Same belt-and-braces as `installBoundFleet()`
 * beside it, for the same measured reason.
 */
export const resetResolveModelDouble = (): void => {
  tripwire = null;
  resolveModel.mockClear();
};
