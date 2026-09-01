import type {
  EndpointStat,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { describe, expect, test } from "bun:test";
import { ROLE_BINDINGS } from "../../../src/lib/model-registry/role-bindings";
import {
  gatewayAdapter,
  gatewayProviderOptions,
} from "../../../src/lib/model-registry/transports/gateway";
import {
  scalewayAdapter,
  scalewayProviderOptions,
} from "../../../src/lib/model-registry/transports/scaleway";
import type {
  ReasoningRequest,
  TransportRequest,
} from "../../../src/lib/model-registry/transports/types";
import type {
  ModelProfile,
  ReasoningLevel,
} from "../../../src/lib/model-registry/types";
import { boundProfile } from "../../lib/live-fleet";

/**
 * What each transport actually carries — the parity audit, pinned.
 *
 * Both cases below were LIVE defects on 2026-08-30, and both had the same
 * shape: an adapter dropped something the resolver had already decided, and its
 * own `capabilities()` reported the model as clean. That combination is the one
 * this suite exists to prevent, because it produces a quality regression with
 * no symptom to trace — the operator surface says the model is fine.
 */

const endpoint = (
  provider: string,
  over: Partial<EndpointStat> = {},
): EndpointStat => ({
  provider,
  displayName: provider,
  wireNames: { gateway: provider },
  contextLength: 131_072,
  pricing: { inputPerMTok: 1, outputPerMTok: 4 },
  supportedParameters: ["tools", "reasoning"],
  ...over,
});

const live = (over: Partial<LiveModelState> = {}): LiveModelState =>
  ({
    profileKey: "test-model",
    status: "published",
    transport: "gateway",
    enabled: true,
    disabledReason: null,
    modelIds: { gateway: "vendor/test-model" },
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
    endpointStats: [],
    aaMetrics: null,
    dynamicProfile: null,
    boundRoles: [],
    source: "sync",
    syncedAt: new Date(),
    ...over,
  }) as LiveModelState;

/** A profile with a hand-measured exclusion, mirroring `openai.ts`. */
const withIgnore = (ignore: string[]): ModelProfile => {
  const base = boundProfile(ROLE_BINDINGS.chat.profileKey);
  return {
    ...base,
    assessment: {
      ...base.assessment,
      provider: { ...base.assessment.provider, ignore },
    },
  };
};

const gatewayRequest = (
  endpoints: EndpointStat[],
  over: Partial<TransportRequest> = {},
): TransportRequest => ({
  modelId: "vendor/test-model",
  binding: ROLE_BINDINGS.chat,
  profile: boundProfile(ROLE_BINDINGS.chat.profileKey),
  live: live({ endpointStats: endpoints }),
  endpoints,
  ...over,
});

describe("gateway: a hand-measured exclusion reaches the wire", () => {
  const ENDPOINTS = [
    endpoint("fireworks"),
    endpoint("together"),
    endpoint("baseten"),
  ];

  test("a profile's `ignore` is subtracted from the allow-list", () => {
    // The defect: `allowList` filtered on quarantines alone, so `fireworks`
    // — excluded by hand on `gpt-oss-20b` after being measured broken — was
    // free to serve the model on this transport while the OpenRouter path
    // excluded it. One model, two answers about who may serve it.
    const options = gatewayProviderOptions(
      gatewayRequest(ENDPOINTS, { profile: withIgnore(["fireworks"]) }),
    );
    expect(options.gateway?.only).toEqual(["together", "baseten"]);
  });

  test("an exclusion STORED ON THE ROW excludes just as well", () => {
    // Where the exclusion is heading. The row is the durable home — the sync
    // carries it forward every pass — and reading it here is what will let the
    // profile field disappear without the host coming back.
    const options = gatewayProviderOptions(
      gatewayRequest(ENDPOINTS, {
        live: live({
          endpointStats: ENDPOINTS,
          providerPool: { gateway: { ignore: ["fireworks"] } },
        }),
      }),
    );
    expect(options.gateway?.only).toEqual(["together", "baseten"]);
  });

  test("with no exclusion every endpoint stays in the pool", () => {
    const options = gatewayProviderOptions(gatewayRequest(ENDPOINTS));
    expect(options.gateway?.only).toEqual(["fireworks", "together", "baseten"]);
  });

  test("an exclusion that cannot be expressed is REPORTED, not swallowed", () => {
    // No endpoint list means no allow-list, and an allow-list is the only way
    // this dialect can say "not that one". Before, only a quarantine produced
    // this gap, so a curated exclusion vanished with the scorecard still green.
    const result = gatewayAdapter.capabilities(
      gatewayRequest([], { profile: withIgnore(["fireworks"]) }),
    );
    expect(result.exclusions).toBe(false);
    expect(result.gaps.join(" ")).toContain("an exclusion is in force");
  });
});

describe("gateway: require_parameters is honoured by pool composition", () => {
  test("a tool-less host is dropped on a cold row, and named", () => {
    // `require_parameters` has no gateway equivalent; the doctrine is that pool
    // composition stands in for it. That is true once a sync has written a
    // vetted pool and false before — and a host that silently drops `tools`
    // answers in XML-looking prose through SSE.
    const endpoints = [
      endpoint("fireworks"),
      endpoint("nocalls", { supportedParameters: ["reasoning"] }),
    ];
    const request = gatewayRequest(endpoints);
    expect(gatewayProviderOptions(request).gateway?.only).toEqual([
      "fireworks",
    ]);
    const result = gatewayAdapter.capabilities(request);
    expect(result.gaps.join(" ")).toContain("not advertising tool calling");
    // The pool we will actually route to does support tools, so the capability
    // must say so rather than grading hosts we just excluded.
    expect(result.tools).toBe(true);
  });

  test("a vetted pool is trusted as composed", () => {
    // The sync already applied the policy when it wrote the pool; re-filtering
    // here would second-guess it with less information than it had.
    const endpoints = [endpoint("fireworks"), endpoint("together")];
    const request = gatewayRequest(endpoints, {
      live: live({
        endpointStats: endpoints,
        providerPool: { gateway: { only: ["fireworks", "together"] } },
      }),
    });
    expect(gatewayProviderOptions(request).gateway?.only).toEqual([
      "fireworks",
      "together",
    ]);
  });
});

const scalewayRequest = (
  reasoning: ReasoningRequest | undefined,
  profile: ModelProfile = boundProfile(ROLE_BINDINGS.chat.profileKey),
): TransportRequest => ({
  modelId: "vendor/test-model",
  binding: ROLE_BINDINGS.chat,
  profile,
  endpoints: [endpoint("scaleway")],
  ...(reasoning === undefined ? {} : { reasoning }),
});

/** A profile whose published ladder does or does not carry a `none` rung. */
const withLadder = (
  supportedEfforts: readonly ReasoningLevel[],
): ModelProfile => {
  const base = boundProfile(ROLE_BINDINGS.chat.profileKey);
  return {
    ...base,
    catalog: {
      ...base.catalog,
      reasoning: { mandatory: false, supportedEfforts },
    },
  };
};

describe("scaleway: the reasoning envelope is rendered or declared missing", () => {
  test("an effort ladder reaches the wire as reasoning_effort", () => {
    // The defect: `buildModel` was `chatModel(request.modelId)` and nothing
    // else, so a user's chosen depth and a workflow's stored level were both
    // dropped between the resolver and the request body.
    const options = scalewayProviderOptions(
      scalewayRequest({ kind: "effort", effort: "high" }),
    );
    expect(options.scaleway?.reasoningEffort).toBe("high");
  });

  test("a token BUDGET is refused rather than downgraded to an effort", () => {
    // A budget is a hard allowance and an effort is a hint the model may
    // ignore. Substituting one for the other is the quiet downgrade the
    // transport contract forbids — and that allowance is what has kept some
    // models from spending an entire turn thinking.
    const request = scalewayRequest({ kind: "budget", maxTokens: 5_000 });
    expect(scalewayProviderOptions(request).scaleway).toBeUndefined();
    const result = scalewayAdapter.capabilities(request);
    expect(result.reasoning).toBe(false);
    expect(result.gaps.join(" ")).toContain("token budget cannot be expressed");
  });

  test("`off` is sent only when the model publishes a `none` rung", () => {
    // Sending a value the pool never advertised is what empties a pool instead
    // of dropping a field.
    const withNone = scalewayRequest(
      { kind: "off" },
      withLadder(["high", "none"]),
    );
    expect(scalewayProviderOptions(withNone).scaleway?.reasoningEffort).toBe(
      "none",
    );

    const withoutNone = scalewayRequest({ kind: "off" }, withLadder(["high"]));
    expect(scalewayProviderOptions(withoutNone).scaleway).toBeUndefined();
    expect(scalewayAdapter.capabilities(withoutNone).gaps.join(" ")).toContain(
      "publishes no `none` rung",
    );
  });

  test("no reasoning request means no reasoning key at all", () => {
    expect(scalewayProviderOptions(scalewayRequest(undefined))).toEqual({});
  });
});
