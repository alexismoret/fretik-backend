import { afterEach, describe, expect, test } from "bun:test";
import {
  canProbeIntegrity,
  probeableTransports,
} from "../../src/services/model-registry/bench/integrity-probe";

/**
 * Which transports the integrity bench may call.
 *
 * The rule is one sentence — a model is benched on the transport it routes
 * through, or not at all — and it was broken in a way nothing could see. This
 * deployment routes entirely through OpenRouter and holds no Vercel AI Gateway
 * account, while discovery keeps finding gateway-served models and filing them
 * with `transport: "gateway"`. Every one of those reached the probe, spent a
 * slot of the nightly budget and returned nothing, so the sweep looked busy and
 * measured no model anybody uses.
 *
 * Reading the credential is what fixes it, which makes this the one function in
 * the bench that is not pure — hence a test that drives `Bun.env` directly
 * rather than a fixture.
 */

const KEYS = ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY"] as const;
const saved = new Map(KEYS.map((key) => [key, Bun.env[key]]));

const setKeys = (present: Partial<Record<(typeof KEYS)[number], string>>) => {
  for (const key of KEYS) {
    const value = present[key];
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
};

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
});

describe("canProbeIntegrity", () => {
  test("a transport with a dialect but no credential cannot be probed", () => {
    // The exact production shape on 2026-09-11: OpenRouter serves the fleet,
    // the gateway is a catalogue we read and an account we do not have.
    setKeys({ OPENROUTER_API_KEY: "test-key" });
    expect(canProbeIntegrity("openrouter")).toBe(true);
    expect(canProbeIntegrity("gateway")).toBe(false);
    expect(probeableTransports()).toEqual(["openrouter"]);
  });

  test("a transport with no pinning dialect is never probeable, key or not", () => {
    // Scaleway serves every model from one host, so there is nothing to pin and
    // nothing to compare — its integrity is watched on real traffic instead.
    setKeys({ OPENROUTER_API_KEY: "test-key" });
    expect(canProbeIntegrity("scaleway")).toBe(false);
    expect(canProbeIntegrity("custom")).toBe(false);
  });

  test("no credentials at all means nothing is probeable", () => {
    setKeys({});
    expect(probeableTransports()).toEqual([]);
  });

  test("an empty string is not a credential", () => {
    // `Bun.env` returns "" for a variable declared and left blank in a `.env`,
    // which is the state a half-finished setup leaves behind. Treating it as a
    // key would send every probe out to be refused.
    setKeys({ OPENROUTER_API_KEY: "", AI_GATEWAY_API_KEY: "set" });
    expect(canProbeIntegrity("openrouter")).toBe(false);
    expect(canProbeIntegrity("gateway")).toBe(true);
  });
});
