import { describe, expect, test } from "bun:test";
import {
  registerLangfuseOnce,
  type LangfuseWiring,
  type TelemetryGlobals,
} from "../../../src/lib/langfuse-registration";

/**
 * The guard that makes `bun --hot` harmless.
 *
 * What it is really defending is a number nobody can sanity-check downstream:
 * a second AI SDK telemetry integration exports every model call twice, under
 * two span ids, and Langfuse v4 ingests both — so a cost read back is silently
 * doubled. The 2026-09-05 eval run reported 129.50 $ for 5.89 $ of traffic
 * after 21 reloads.
 *
 * Every test here drives a plain object rather than the real `globalThis`, so
 * the guard is exercised without a Langfuse credential and without leaving a
 * registration behind for whatever test runs next (this suite is `randomize`d).
 */

/** A wiring whose build and install are both countable. */
const wiringSpy = (): {
  wire: () => LangfuseWiring;
  wired: () => number;
  installed: () => number;
} => {
  let wired = 0;
  let installed = 0;
  return {
    wire: () => {
      wired++;
      return {
        registration: {
          processor: {
            forceFlush: () => Promise.resolve(),
          },
        },
        install: () => {
          installed++;
        },
      };
    },
    wired: () => wired,
    installed: () => installed,
  };
};

describe("registerLangfuseOnce", () => {
  test("a second evaluation installs nothing and reuses the first processor", () => {
    const globals: TelemetryGlobals = {};
    const spy = wiringSpy();

    const first = registerLangfuseOnce(globals, spy.wire);
    globals.AI_SDK_TELEMETRY_INTEGRATIONS = { length: 1 };
    const second = registerLangfuseOnce(globals, spy.wire);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(spy.installed()).toBe(1);
    // Identity, not equality: the flush handle the rest of the process holds
    // has to be the one the tracer provider actually took.
    expect(second.registration.processor).toBe(first.registration.processor);
  });

  test("a reload does not even BUILD a second processor", () => {
    const globals: TelemetryGlobals = {};
    const spy = wiringSpy();

    registerLangfuseOnce(globals, spy.wire);
    registerLangfuseOnce(globals, spy.wire);
    registerLangfuseOnce(globals, spy.wire);

    // `wire` is a factory precisely so this stays 1: a `LangfuseSpanProcessor`
    // built on a reload is not merely wasted, it is the orphan that
    // `flushLangfuse` would then be flushing instead of the live one.
    expect(spy.wired()).toBe(1);
  });

  test("an unrelated integration registered by someone else is left alone", () => {
    // Somebody else's integration is already on the global array. The guard
    // must not treat that as "Langfuse is installed" (it would never install)
    // nor add a second Langfuse one — it owns its slot, not the array.
    const globals: TelemetryGlobals = {
      AI_SDK_TELEMETRY_INTEGRATIONS: { length: 1 },
    };
    const spy = wiringSpy();

    const outcome = registerLangfuseOnce(globals, () => {
      const wiring = spy.wire();
      return {
        registration: wiring.registration,
        install: () => {
          wiring.install();
          globals.AI_SDK_TELEMETRY_INTEGRATIONS = { length: 2 };
        },
      };
    });

    expect(spy.installed()).toBe(1);
    expect(outcome.reused).toBe(false);
    // Reported AFTER installing, so the boot line names what is really there.
    expect(outcome.integrations).toBe(2);
  });

  test("the count is read after installing, so a first boot reports 1", () => {
    const globals: TelemetryGlobals = {};
    const spy = wiringSpy();

    const outcome = registerLangfuseOnce(globals, () => {
      const wiring = spy.wire();
      return {
        registration: wiring.registration,
        install: () => {
          wiring.install();
          globals.AI_SDK_TELEMETRY_INTEGRATIONS = { length: 1 };
        },
      };
    });

    expect(outcome.integrations).toBe(1);
  });

  test("the slot is what carries across, not the caller's module state", () => {
    // Two separate callers sharing one `globalThis` is exactly the shape of a
    // hot reload: the module-level const is gone, the global is not.
    const globals: TelemetryGlobals = {};
    const before = wiringSpy();
    const after = wiringSpy();

    const first = registerLangfuseOnce(globals, before.wire);
    const second = registerLangfuseOnce(globals, after.wire);

    expect(after.wired()).toBe(0);
    expect(second.registration.processor).toBe(first.registration.processor);
  });
});
