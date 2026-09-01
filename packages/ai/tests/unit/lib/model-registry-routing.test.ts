import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { describe, expect, test } from "bun:test";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import { applyLiveState } from "../../../src/lib/model-registry/transports/openrouter";
import type { TransportRequest } from "../../../src/lib/model-registry/transports/types";
import { boundProfile } from "../../lib/live-fleet";

/**
 * What actually leaves the process for OpenRouter.
 *
 * The pool the nightly sync computes used to inform statistics and nothing
 * else: routing carried whatever a profile had declared by hand, which for 20
 * of 22 published models was nothing. An open, unordered pool lets any host
 * answer any turn — measured 2026-08-29, `gpt-oss-20b` was served by CoreWeave
 * three weeks after CoreWeave was caught injecting zero-width characters into
 * another model's output. These cases pin the pool to the wire.
 */

const endpoint = (
  provider: string,
  wire = provider,
  over: Partial<EndpointStat> = {},
): EndpointStat => ({
  provider,
  displayName: provider,
  wireNames: { openrouter: wire },
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
  ...over,
});

const ENDPOINTS = [
  endpoint("fireworks"),
  endpoint("together"),
  endpoint("bedrock", "amazon-bedrock"),
  endpoint("coreweave"),
];

const live = (over: Partial<LiveModelState> = {}): LiveModelState =>
  ({
    profileKey: "test-model",
    status: "published",
    transport: "openrouter",
    enabled: true,
    disabledReason: null,
    modelIds: { openrouter: "vendor/test-model" },
    providerPool: {},
    quarantinedProviders: [],
    poolWidened: false,
    lastResort: false,
    effectiveContextLength: 128_000,
    effectiveMaxOutput: 8_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 4 },
    creditMultiplier: 1,
    health: "healthy",
    healthScore: 100,
    policyReport: null,
    policyFailStreak: 0,
    endpointStats: ENDPOINTS,
    aaMetrics: null,
    dynamicProfile: null,
    boundRoles: [],
    source: "sync",
    syncedAt: new Date(),
    ...over,
  }) as LiveModelState;

const request = (state: LiveModelState): TransportRequest => ({
  modelId: "vendor/test-model",
  binding: ROLE_BINDINGS.chat,
  profile: boundProfile(ROLE_BINDINGS.chat.profileKey),
  live: state,
  endpoints: ENDPOINTS,
});

const NOW = new Date("2026-08-29T12:00:00Z");

const quarantine = (provider: string) => ({
  provider,
  transport: "openrouter" as const,
  kind: "forbidden-codepoints" as const,
  quarantinedAt: "2026-08-29T00:00:00.000Z",
  releaseAt: "2026-09-05T00:00:00.000Z",
  incidentIds: [],
  reason: "test",
});

describe("the computed pool reaches the wire", () => {
  test("a role with NO provider block still gets the vetted pool", () => {
    // This is the case that was silently open: no quarantine, no hand-written
    // list, so the old code returned early and sent nothing at all.
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: {
            openrouter: { only: ["fireworks", "together"], sort: "throughput" },
          },
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["fireworks", "together"]);
    expect(result?.provider?.sort).toBe("throughput");
  });

  test("a role WITH a provider block but no quarantine gets it too", () => {
    const result = applyLiveState(
      { provider: { require_parameters: true } },
      request(
        live({
          providerPool: {
            openrouter: { only: ["fireworks"], sort: "throughput" },
          },
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["fireworks"]);
    expect(result?.provider?.sort).toBe("throughput");
    // The envelope's own settings survive alongside it.
    expect(result?.provider?.require_parameters).toBe(true);
  });

  test("the live pool outranks a hand-written one", () => {
    // The profile's list was written once; the live list was measured last
    // night.
    const result = applyLiveState(
      { provider: { only: ["coreweave"] } },
      request(live({ providerPool: { openrouter: { only: ["fireworks"] } } })),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["fireworks"]);
  });

  test("pool members go out as SLUGS, not as identities", () => {
    // `bedrock` is our identity for a host OpenRouter calls `amazon-bedrock`.
    // Sending the identity would silently match nothing.
    const result = applyLiveState(
      undefined,
      request(live({ providerPool: { openrouter: { only: ["bedrock"] } } })),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["amazon-bedrock"]);
  });
});

describe("ordering", () => {
  test("an explicit `order` suppresses the sort entirely", () => {
    // OpenRouter treats an order as the whole preference and silently drops a
    // sort sent with it, so emitting both would misrepresent what we asked for.
    const result = applyLiveState(
      { provider: { order: ["fireworks"] } },
      request(
        live({
          providerPool: {
            openrouter: { only: ["fireworks"], sort: "throughput" },
          },
        }),
      ),
      NOW,
    );
    expect(result?.provider?.order).toEqual(["fireworks"]);
    expect(result?.provider?.sort).toBeUndefined();
  });

  test("without an order, the live sort wins over the profile's", () => {
    const result = applyLiveState(
      { provider: { sort: "price" } },
      request(live({ providerPool: { openrouter: { sort: "throughput" } } })),
      NOW,
    );
    expect(result?.provider?.sort).toBe("throughput");
  });
});

describe("quarantine still governs", () => {
  test("a quarantined host is dropped from the pool AND ignored by slug", () => {
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: {
            openrouter: { only: ["fireworks", "bedrock"], sort: "throughput" },
          },
          quarantinedProviders: [quarantine("bedrock")],
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["fireworks"]);
    expect(result?.provider?.ignore).toEqual(["amazon-bedrock"]);
  });

  test("an EXPIRED quarantine no longer narrows anything", () => {
    const stale = {
      ...quarantine("bedrock"),
      releaseAt: "2026-08-01T00:00:00.000Z",
    };
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: { openrouter: { only: ["fireworks", "bedrock"] } },
          quarantinedProviders: [stale],
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toEqual(["fireworks", "amazon-bedrock"]);
    expect(result?.provider?.ignore).toBeUndefined();
  });

  test("a widened pool drops `only` but keeps excluding the bad host", () => {
    // `poolWidened` means quarantines exhausted the vetted list; routing is let
    // out to reach anyone, EXCEPT the host that caused it.
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: { openrouter: { only: ["fireworks"] } },
          quarantinedProviders: [quarantine("fireworks")],
          poolWidened: true,
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toBeUndefined();
    expect(result?.provider?.ignore).toEqual(["fireworks"]);
  });
});

describe("an exclusion stored on the row", () => {
  test("reaches the wire without any profile carrying it", () => {
    // Until 2026-08-30 this read the profile's `ignore` alone, so an exclusion
    // could be recorded in the database and still be served by the host it
    // named. It is the same gap the gateway had, on the other transport, and it
    // is what has to close before the curated field can go.
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: {
            openrouter: {
              only: ["fireworks", "together"],
              ignore: ["together"],
            },
          },
        }),
      ),
      NOW,
    );
    expect(result?.provider?.ignore).toEqual(["together"]);
  });

  test("survives a widened pool, which is the case it exists for", () => {
    // A widened pool skips `only` entirely. If the exclusion lived only as an
    // absence from that list — which is what erasing `ignore` each sync left it
    // as — widening would hand the turn straight back to the discredited host.
    const result = applyLiveState(
      undefined,
      request(
        live({
          providerPool: {
            openrouter: { only: ["fireworks"], ignore: ["together"] },
          },
          poolWidened: true,
        }),
      ),
      NOW,
    );
    expect(result?.provider?.only).toBeUndefined();
    expect(result?.provider?.ignore).toEqual(["together"]);
  });
});
