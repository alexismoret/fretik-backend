import type {
  DynamicProfile,
  LiveModelState,
} from "@fretik/shared/model-registry/types";
import { afterEach, describe, expect, test } from "bun:test";
import {
  getEffectiveProfile,
  listEffectiveProfiles,
  synthesizeProfileFromLive,
} from "../../../src/lib/model-registry/effective";
import {
  clearResolvedModelCache,
  selectableReasoningLevels,
} from "../../../src/lib/model-registry/resolve";
import { setLiveStateDouble } from "../../lib/live-state-double";

/**
 * The half of the registry that needs no release.
 *
 * `promote` writes a row; until this layer existed nothing read it —
 * `getProfile` threw on any key outside `MODEL_PROFILES` and `dynamicProfile`
 * was written by the sync and consumed nowhere, so a promoted model was
 * invisible to every picker. What is asserted here is the synthesis itself,
 * because each of its defaults is a decision about a model NOBODY HAS LOOKED
 * AT, and the wrong default is silent every time.
 */

const dynamic = (over: Partial<DynamicProfile> = {}): DynamicProfile => ({
  displayName: "Frontier 9",
  family: "acme",
  contextLength: 262_144,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["tools", "max_tokens"],
  supportsReasoning: false,
  supportsTools: true,
  derivedFrom: { source: "gateway+openrouter", at: "2026-08-30T03:00:00.000Z" },
  ...over,
});

const row = (over: Partial<LiveModelState> = {}): LiveModelState => ({
  profileKey: "acme-frontier-9",
  status: "published",
  transport: "openrouter",
  enabled: true,
  disabledReason: null,
  modelIds: { openrouter: "acme/frontier-9", gateway: "acme/frontier9" },
  providerPool: {},
  quarantinedProviders: [],
  poolWidened: false,
  lastResort: false,
  effectiveContextLength: 260_096,
  effectiveMaxOutput: 32_768,
  pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  creditMultiplier: 0.7,
  health: "healthy",
  healthScore: 90,
  policyReport: null,
  endpointStats: [],
  aaMetrics: null,
  releasedAt: null,
  aaSlug: null,
  dynamicProfile: dynamic(),
  boundRoles: [],
  source: "sync",
  syncedAt: null,
  ...over,
});

afterEach(() => {
  setLiveStateDouble();
  clearResolvedModelCache();
});

describe("synthesis defaults", () => {
  test("the model id is the one for the transport the row ROUTES through", () => {
    // Never another transport's spelling of the same model: sending
    // `acme/frontier9` to OpenRouter is a 404, not a synonym.
    const profile = synthesizeProfileFromLive(row());
    expect(profile?.catalog.id).toBe("acme/frontier-9");
    expect(
      synthesizeProfileFromLive(row({ transport: "gateway" }))?.catalog.id,
    ).toBe("acme/frontier9");
  });

  test("context is the EFFECTIVE length, not the catalogue headline", () => {
    // The smallest any allowed endpoint offers, minus the safety margin.
    // Budgeting against the headline overflows the first turn that lands on
    // the smallest host.
    const profile = synthesizeProfileFromLive(row());
    expect(profile?.catalog.contextLength).toBe(260_096);
    expect(profile?.catalog.contextLength).not.toBe(262_144);
  });

  /**
   * The depth menu of a model nobody hand-wrote a profile for.
   *
   * This block used to assert the opposite — that no ladder is ever
   * synthesised — on the belief that "the catalogues publish the capability
   * without the ladder". That was measurably false: OpenRouter publishes a
   * reasoning contract for 271 of its 396 models and the exact ladder for 130
   * of them, so the refusal shipped every promoted model with its depth control
   * permanently dead. What survives from the old reasoning is the part that was
   * right — nothing is INVENTED, and a model the catalogue said nothing about
   * still gets no ladder.
   */
  describe("reasoning, from the published contract", () => {
    const withContract = (reasoning: DynamicProfile["reasoning"]) =>
      synthesizeProfileFromLive(
        row({
          dynamicProfile: dynamic({
            supportsReasoning: true,
            supportedParameters: ["tools", "reasoning"],
            ...(reasoning === undefined ? {} : { reasoning }),
          }),
        }),
      );

    test("a published ladder becomes a real depth menu", () => {
      const profile = withContract({
        mandatory: false,
        supportedEfforts: ["high", "medium", "low"],
        defaultEffort: "medium",
      });
      expect(profile?.catalog.reasoning?.supportedEfforts).toEqual([
        // Re-ordered onto the PRODUCT's scale, ascending, so "the cheapest
        // rung" means the same thing whichever order an upstream lists.
        "low",
        "medium",
        "high",
      ]);
      expect(profile?.assessment.reasoning).toEqual({
        style: "effort",
        // The MIDDLE rung of three.
        defaultLevel: "medium",
      });
      expect(selectableReasoningLevels(profile!)).toEqual([
        "low",
        "medium",
        "high",
      ]);
    });

    test("the default is the MIDDLE rung, not the vendor's own default", () => {
      // A vendor default is tuned for a vendor benchmark. Measured across the
      // 22 curated profiles, ours disagreed with it on 11 — in both directions
      // (`low` where the vendor said `medium`, `xhigh` where it also said
      // `medium`), so it tracks nothing this product cares about. Hand-fixing
      // that is what an automatic registry cannot keep doing, since a promoted
      // model gets no hand-fixing at all.
      const profile = withContract({
        mandatory: false,
        supportedEfforts: ["max", "xhigh", "high", "medium", "low"],
        defaultEffort: "low",
      });
      expect(profile?.assessment.reasoning.defaultLevel).toBe("high");
      // The vendor's answer is not copied onto the profile — it is recorded
      // where it is read from (the row's `dynamicProfile`) and nothing in the
      // product consults it.
      expect(profile?.catalog.reasoning).toEqual({
        mandatory: false,
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      });
    });

    test("an EVEN ladder takes the upper of the two middles", () => {
      // A default that under-thinks reads as a worse model; one that
      // over-thinks reads as a slower one, and only the second is visibly a
      // choice a team can undo.
      const four = withContract({
        mandatory: false,
        supportedEfforts: ["high", "medium", "low", "minimal"],
      });
      expect(four?.assessment.reasoning.defaultLevel).toBe("medium");

      // The degenerate case a two-rung model creates: `glm-5.2` publishes
      // exactly `high` and `xhigh`, so the rule lands on `xhigh`.
      const two = withContract({
        mandatory: false,
        supportedEfforts: ["xhigh", "high"],
      });
      expect(two?.assessment.reasoning.defaultLevel).toBe("xhigh");
    });

    test("the rule scales with the range the model actually offers", () => {
      // A single-rung ladder has only one answer, and it is that rung.
      const one = withContract({
        mandatory: false,
        supportedEfforts: ["high"],
      });
      expect(one?.assessment.reasoning.defaultLevel).toBe("high");
    });

    test("a rung the product does not model is dropped, not passed through", () => {
      // A catalogue growing a level must not put a value on the wire that the
      // level→budget table cannot map.
      const profile = withContract({
        mandatory: false,
        supportedEfforts: ["ultra", "high", "low"],
      });
      expect(profile?.catalog.reasoning?.supportedEfforts).toEqual([
        "low",
        "high",
      ]);
    });

    test("no ladder but a contract ⇒ a BUDGET, defaulting cheap", () => {
      // What curation independently chose for the same shape of model
      // (`claude-haiku-4.5`, `minimax-m3`): the level→budget table steers it.
      // `low` because an unmeasured model's thinking is a cost nobody asked
      // for, and raising it is one click.
      expect(withContract({ mandatory: false })?.assessment.reasoning).toEqual({
        style: "max-tokens",
        defaultLevel: "low",
      });
    });

    test("a `none` rung counts as a rung, and can still be the middle", () => {
      // `none` is a published level like any other, so it takes part in the
      // count. On `["none","low","high"]` the middle is `low`, which is also
      // what a reader would expect — but the rule is arithmetic, not a
      // preference for thinking, and saying so here keeps a later reader from
      // "fixing" it back into a special case.
      const profile = withContract({
        mandatory: false,
        supportedEfforts: ["high", "low", "none"],
        defaultEffort: "ultra",
      });
      expect(profile?.assessment.reasoning.defaultLevel).toBe("low");
      // An unmodelled vendor default is simply not recorded.
      expect(profile?.catalog.reasoning?.defaultEffort).toBeUndefined();
    });

    test("no contract at all ⇒ no ladder invented", () => {
      const profile = withContract(undefined);
      expect(profile?.catalog.reasoning).toBeUndefined();
      expect(profile?.assessment.reasoning).toEqual({
        style: "none",
        defaultLevel: "none",
      });
    });
  });

  test("images and PDFs ride natively when published; video and audio do not", () => {
    const profile = synthesizeProfileFromLive(
      row({
        dynamicProfile: dynamic({
          inputModalities: ["text", "image", "file", "video", "audio"],
        }),
      }),
    );
    // `file` was held back as family knowledge no catalogue publishes. Measured
    // 2026-08-30 across the 22 curated profiles, the published `file` modality
    // and the hand-written activation agree on ALL 22 — it was a published fact
    // the whole time, and withholding it meant a promoted model silently lost
    // native PDF. Video and audio stay off for a different reason that has not
    // changed: no call site produces parts for them, which is a fact about us.
    expect(profile?.assessment.nativeInput).toEqual({
      image: true,
      video: false,
      fileMimeTypes: ["application/pdf"],
      audio: false,
    });
  });

  test("no `file` modality means no native PDF", () => {
    const profile = synthesizeProfileFromLive(
      row({ dynamicProfile: dynamic({ inputModalities: ["text", "image"] }) }),
    );
    expect(profile?.assessment.nativeInput.fileMimeTypes).toEqual([]);
  });

  test("a modality nothing models is dropped rather than carried through", () => {
    const profile = synthesizeProfileFromLive(
      row({
        dynamicProfile: dynamic({
          inputModalities: ["text", "image", "hologram"],
        }),
      }),
    );
    expect(profile?.catalog.inputModalities).toEqual(["text", "image"]);
  });

  test("the cache claim is read off the prices, not assumed", () => {
    // This was a blanket `none`, on the reasoning that claiming `implicit`
    // would grant a discount nobody published. True — but the prices publish
    // it, so refusing to read them over-reported the cost of every model that
    // does cache, on the term that dominates a turn.
    expect(synthesizeProfileFromLive(row())?.assessment.cache).toEqual({
      strategy: "none",
    });

    const caching = synthesizeProfileFromLive(
      row({
        pricing: {
          inputPerMTok: 0.4,
          outputPerMTok: 1.6,
          cacheReadPerMTok: 0.08,
        },
      }),
    );
    expect(caching?.assessment.cache).toEqual({ strategy: "implicit" });
  });

  test("a cache read quoted at full price is still no cache", () => {
    // CoreWeave prices gpt-oss cache reads at exactly the input rate. A
    // discount of 1.0× must not read as caching.
    const flat = synthesizeProfileFromLive(
      row({
        pricing: {
          inputPerMTok: 0.4,
          outputPerMTok: 1.6,
          cacheReadPerMTok: 0.4,
        },
      }),
    );
    expect(flat?.assessment.cache).toEqual({ strategy: "none" });
  });

  describe("the quantization floor is anchored, not merely non-empty", () => {
    const withQuant = (...quants: (string | undefined)[]) =>
      synthesizeProfileFromLive(
        row({
          endpointStats: quants.map((quantization, i) => ({
            provider: `host-${i.toString()}`,
            displayName: `Host ${i.toString()}`,
            wireNames: {},
            contextLength: 262_144,
            pricing: { inputPerMTok: 1, outputPerMTok: 4 },
            supportedParameters: ["tools"],
            ...(quantization === undefined ? {} : { quantization }),
          })),
        }),
      )?.assessment.provider.quantizations;

    test("a REPORTED good precision survives it → the floor is sent", () => {
      // gpt-oss-120b's shape: six of fourteen hosts serve it at fp4/fp8, and
      // filtering them out leaves bf16 and fp16 hosts standing.
      expect(withQuant("bf16", "unknown", "fp4")).toEqual([
        "bf16",
        "fp16",
        "unknown",
      ]);
    });

    test("only UNREPORTED precisions survive it → the floor is not sent", () => {
      // deepseek-v4-flash's shape, and the case a "does anything survive" test
      // gets wrong: something does survive, and what survives is exactly the
      // hosts that declare nothing. Sending the floor there drops the two whose
      // precision is KNOWN and keeps the two that are silent — a filter on
      // disclosure, costing the pool its fastest member for no measured gain.
      expect(withQuant("fp8", "fp8", "unknown")).toBeUndefined();
    });

    test("nothing reports a precision at all → nothing to filter on", () => {
      expect(withQuant(undefined, undefined)).toBeUndefined();
    });
  });

  test("a ZDR stance nobody stated is NOT invented", () => {
    // `zdr: true` used to be hardcoded, so every promoted model lit a
    // zero-retention badge in the UI regardless of what its routes said. With
    // no endpoint data there is no stance to report, and the field is omitted
    // rather than asserted — "we could not check" is not "checked, clean".
    expect(synthesizeProfileFromLive(row())?.assessment.provider).toEqual({});
  });

  test("the ZDR stance is read from the routes, and one dissenter decides it", () => {
    const stat = (hasZdr: boolean | undefined) => ({
      provider: hasZdr === true ? "clean" : "leaky",
      displayName: "host",
      wireNames: {},
      contextLength: 262_144,
      pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
      supportedParameters: ["tools", "max_tokens"],
      ...(hasZdr === undefined ? {} : { hasZdr }),
    });

    const all = synthesizeProfileFromLive(
      row({ endpointStats: [stat(true), stat(true)] }),
    );
    expect(all?.assessment.provider.zdr).toBe(true);

    // A pool is only as private as its least private member: one route that
    // retains is enough to make the badge a lie.
    const mixed = synthesizeProfileFromLive(
      row({ endpointStats: [stat(true), stat(false)] }),
    );
    expect(mixed?.assessment.provider.zdr).toBe(false);

    // Routes that never declared leave the stance unset, not false — the same
    // "absent is not a negative" rule the eligibility engine runs on.
    const silent = synthesizeProfileFromLive(
      row({ endpointStats: [stat(undefined)] }),
    );
    expect(silent?.assessment.provider.zdr).toBeUndefined();
  });

  test("`max_tokens` is omitted when no route advertises it", () => {
    // Sending a parameter the pool does not advertise empties the pool with a
    // 404 rather than dropping the field. The four curated OpenAI profiles set
    // this by hand because their ZDR route is Azure; reading the endpoints
    // agrees with all four.
    const azureish = {
      provider: "azure",
      displayName: "Azure",
      wireNames: {},
      contextLength: 262_144,
      pricing: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
      supportedParameters: ["tools", "max_completion_tokens"],
    };
    expect(
      synthesizeProfileFromLive(row({ endpointStats: [azureish] }))?.assessment
        .provider.omitMaxTokens,
    ).toBe(true);

    // One route that takes it is enough to keep sending it.
    expect(
      synthesizeProfileFromLive(
        row({
          endpointStats: [
            azureish,
            { ...azureish, supportedParameters: ["tools", "max_tokens"] },
          ],
        }),
      )?.assessment.provider.omitMaxTokens,
    ).toBeUndefined();
  });

  test("the cost class comes from the blended pool price", () => {
    const budget = synthesizeProfileFromLive(
      row({ pricing: { inputPerMTok: 0.1, outputPerMTok: 0.4 } }),
    );
    const premium = synthesizeProfileFromLive(
      row({ pricing: { inputPerMTok: 3, outputPerMTok: 12 } }),
    );
    expect(budget?.assessment.costClass).toBe("budget");
    expect(synthesizeProfileFromLive(row())?.assessment.costClass).toBe(
      "standard",
    );
    expect(premium?.assessment.costClass).toBe("premium");
  });

  test("a policy-disabled row gets a tooltip rather than none", () => {
    // `policy` has no counterpart in the profile vocabulary. Dropping it would
    // leave a disabled model with nothing to explain itself.
    const profile = synthesizeProfileFromLive(
      row({ enabled: false, disabledReason: "policy" }),
    );
    expect(profile?.assessment.enabled).toBe(false);
    expect(profile?.assessment.disabledReason).toBe("unavailable");
  });

  test("a row the sync never described yields no profile at all", () => {
    // No context to budget against, no price to bill, no ladder to offer.
    // Serving from such a row would mean inventing all three.
    expect(
      synthesizeProfileFromLive(row({ dynamicProfile: null })),
    ).toBeUndefined();
  });
});

describe("the registry is the rows, and only the rows", () => {
  test("a model resolves from its row alone", () => {
    setLiveStateDouble([row()]);
    const profile = getEffectiveProfile("acme-frontier-9");
    expect(profile?.key).toBe("acme-frontier-9");
    expect(profile?.catalog.id).toBe("acme/frontier-9");
  });

  test("the row is the ONLY source — nothing shadows it", () => {
    // There used to be a curated TypeScript layer that won EN BLOC over the
    // row for the 22 models it named. It was removed on 2026-08-30 because it
    // was measurably staler than the rows it overrode: a curated ladder of
    // `["xhigh","high"]` against a published `["max","high","low"]`, a curated
    // `cache: none` on a model four hosts publish a read discount for. What a
    // row says is what is served.
    setLiveStateDouble([
      row({ pricing: { inputPerMTok: 999, outputPerMTok: 999 } }),
    ]);
    expect(
      getEffectiveProfile("acme-frontier-9")?.assessment.pricing.inputPerMTok,
    ).toBe(999);
  });

  test("a cold snapshot knows nothing, and says so rather than guessing", () => {
    // The previous behaviour — falling back to a TypeScript registry — looked
    // like resilience and was a second registry with its own staler answers.
    setLiveStateDouble();
    expect(getEffectiveProfile("acme-frontier-9")).toBeUndefined();
    expect(listEffectiveProfiles()).toHaveLength(0);
  });

  test("the listing is one entry per described row", () => {
    setLiveStateDouble([row(), row({ profileKey: "acme-second" })]);
    const keys = listEffectiveProfiles().map((profile) => profile.key);
    expect(keys.toSorted()).toEqual(["acme-frontier-9", "acme-second"]);
  });

  test("a row with no dynamicProfile is skipped by the listing, not fatal", () => {
    setLiveStateDouble([
      row(),
      row({ profileKey: "acme-unmeasured", dynamicProfile: null }),
    ]);
    expect(listEffectiveProfiles().map((p) => p.key)).toEqual([
      "acme-frontier-9",
    ]);
  });

  test("the synthesis cache is dropped by the same call that drops models", () => {
    setLiveStateDouble([row()]);
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("acme");
    setLiveStateDouble([
      row({ dynamicProfile: dynamic({ family: "deepseek" }) }),
    ]);
    // Still the memoised answer until the one invalidation path runs.
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("acme");
    clearResolvedModelCache();
    expect(getEffectiveProfile("acme-frontier-9")?.family).toBe("deepseek");
  });
});
