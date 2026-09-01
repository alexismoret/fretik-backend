import { describe, expect, test } from "bun:test";
import type { EndpointStat } from "../../src/model-registry/types";
import {
  probeForTransport,
  wireNameFor,
} from "../../src/services/model-registry/sync/sources/provider-probe";

/**
 * The release re-probe: what decides whether a quarantined host is allowed back
 * into a pool.
 *
 * Two defects it was written for, both of which made quarantines permanent
 * rather than temporary — the opposite of what the release date is for:
 *
 *   - it was hardwired to the GATEWAY, on a fleet routing almost entirely
 *     through OpenRouter, so almost nothing was ever re-probed. Past its
 *     release date the entry simply stopped filtering and sat on the row
 *     forever, a record of a decision nobody revisited;
 *   - it sent our IDENTITY name where a transport's wire name belongs. The
 *     gateway rejects an unknown name outright, which reads as "the host still
 *     refuses" — so a host the two catalogues spell differently had its
 *     quarantine extended by another week, every week, indefinitely.
 */

const endpoint = (
  over: Partial<EndpointStat> & { provider: string },
): EndpointStat => ({
  displayName: over.provider,
  contextLength: 200_000,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools"],
  wireNames: {},
  ...over,
});

describe("probeForTransport", () => {
  test("the two aggregators can be asked", () => {
    expect(probeForTransport("gateway")).toBeDefined();
    expect(probeForTransport("openrouter")).toBeDefined();
  });

  test("scaleway cannot, and that is an ANSWER", () => {
    // One host serves every model there, so there is no second host to pin
    // against and nothing a probe could distinguish: asking would return "yes"
    // for a model that is merely still served, which is not the question.
    // `undefined` lets the caller release optimistically and say so, instead
    // of holding an exclusion nobody can ever lift.
    expect(probeForTransport("scaleway")).toBeUndefined();
  });

  test("a transport we cannot reason about cannot either", () => {
    // `custom` is a base URL somebody typed in.
    expect(probeForTransport("custom")).toBeUndefined();
  });
});

describe("wireNameFor", () => {
  test("returns the name THIS transport expects, not our identity", () => {
    // Measured 2026-08-29: our identity folds `Together` to `together`, while
    // the gateway's own filter spells it `togetherai`. Sending the identity is
    // the request the gateway's error message came from.
    const endpoints = [
      endpoint({
        provider: "together",
        wireNames: { gateway: "togetherai", openrouter: "together" },
      }),
    ];
    expect(wireNameFor(endpoints, "together", "gateway")).toBe("togetherai");
    expect(wireNameFor(endpoints, "together", "openrouter")).toBe("together");
  });

  test("undefined rather than falling back to the identity name", () => {
    // The critical choice. A probe that cannot be addressed correctly must not
    // run at all: an unknown name is rejected by the gateway and silently
    // ignored by OpenRouter, so its refusal is indistinguishable from the
    // host's own — and the caller would extend the quarantine on it.
    const endpoints = [
      endpoint({ provider: "together", wireNames: { openrouter: "together" } }),
    ];
    expect(wireNameFor(endpoints, "together", "gateway")).toBeUndefined();
  });

  test("undefined for a host the row never recorded", () => {
    expect(wireNameFor([], "ghost", "gateway")).toBeUndefined();
  });

  test("undefined when the row has no endpoint data at all", () => {
    // A freshly added row, before its first sync.
    expect(wireNameFor(null, "together", "gateway")).toBeUndefined();
  });
});
