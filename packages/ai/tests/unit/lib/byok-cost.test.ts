import type {
  JSONObject,
  LanguageModelV4,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { describe, expect, test } from "bun:test";
import { byokCostCarrierMiddleware } from "../../../src/lib/byok-cost";
import {
  extractOpenRouterReport,
  readByokUpstreamCost,
} from "../../../src/lib/model-registry/transports/openrouter";

/**
 * A BYOK call's price, from the wire to the readers.
 *
 * Every payload here is measured against the live API on 2026-09-18, and they
 * are kept side by side because the difficulty is entirely in telling them
 * apart: `cost_details.upstream_inference_cost` is returned on EVERY call, and
 * only `is_byok` says whether it is a second charge or the same charge twice.
 */

/** gen-1789732704-UCuhIabUd0wUAffHENJz — DeepSeek v4 Flash on BaseTen. */
const BYOK_RAW = {
  prompt_tokens: 33_051,
  completion_tokens: 655,
  total_tokens: 33_706,
  cost: 0,
  is_byok: true,
  cost_details: {
    upstream_inference_cost: 0.0025935,
    upstream_inference_prompt_cost: 0.00239382,
    upstream_inference_completions_cost: 0.00019968,
  },
};

/** An ordinary gpt-oss-120b call on Crusoe: the figure RESTATES the bill. */
const ORDINARY_RAW = {
  prompt_tokens: 68,
  completion_tokens: 5,
  total_tokens: 73,
  cost: 4.65e-6,
  is_byok: false,
  cost_details: {
    upstream_inference_cost: 4.65e-6,
    upstream_inference_prompt_cost: 3.4e-6,
    upstream_inference_completions_cost: 1.25e-6,
  },
};

/** A `:free` slug served by Novita: nobody billed anybody. */
const FREE_RAW = {
  prompt_tokens: 12,
  completion_tokens: 5,
  total_tokens: 17,
  cost: 0,
  is_byok: false,
  cost_details: {
    upstream_inference_cost: 0,
    upstream_inference_prompt_cost: 0,
    upstream_inference_completions_cost: 0,
  },
};

describe("reading a BYOK charge off the raw usage block", () => {
  test("a BYOK call reports what the upstream billed our own key", () => {
    // Not the $0 the aggregator invoiced, and not the $0.00429078 the same
    // tokens would cost at the uncached rate: the cache discount is ALREADY
    // deducted from this figure, so subtracting it would count the saving
    // twice.
    expect(readByokUpstreamCost(BYOK_RAW)).toBe(0.0025935);
  });

  test("an ordinary call reports NOTHING, though it carries the same field", () => {
    // The regression this whole path exists to prevent. Summing without
    // checking `is_byok` would double the price of the entire non-BYOK fleet,
    // silently and everywhere at once.
    expect(readByokUpstreamCost(ORDINARY_RAW)).toBeUndefined();
  });

  test("a free model is not BYOK just because its upstream figure is zero", () => {
    expect(readByokUpstreamCost(FREE_RAW)).toBeUndefined();
  });

  test("a BYOK call that billed zero claims no share", () => {
    // A zero is not a bill; carrying it would label the call BYOK on a
    // dashboard while adding nothing to the total.
    expect(
      readByokUpstreamCost({
        is_byok: true,
        cost_details: { upstream_inference_cost: 0 },
      }),
    ).toBeUndefined();
  });

  test("a missing or malformed block is read as not-BYOK, never as an error", () => {
    expect(readByokUpstreamCost(undefined)).toBeUndefined();
    expect(readByokUpstreamCost({})).toBeUndefined();
    expect(readByokUpstreamCost({ is_byok: true })).toBeUndefined();
    expect(
      readByokUpstreamCost({
        is_byok: true,
        cost_details: { upstream_inference_cost: "0.002" },
      }),
    ).toBeUndefined();
  });
});

const usageWith = (raw: JSONObject): LanguageModelV4Usage => ({
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
  ...(raw === undefined ? {} : { raw }),
});

/** What the OpenRouter provider actually puts on a finish part, trimmed. */
const META = (cost: number): SharedV4ProviderMetadata => ({
  openrouter: {
    provider: "BaseTen",
    reasoning_details: [],
    usage: {
      promptTokens: 33_051,
      completionTokens: 655,
      cost,
      costDetails: { upstreamInferenceCost: 0.0025935 },
    },
  },
});

const model: LanguageModelV4 = {
  specificationVersion: "v4",
  provider: "test",
  modelId: "vendor/model-under-test",
  supportedUrls: {},
  doGenerate: () => {
    throw new Error("the fake model is driven through the middleware only");
  },
  doStream: () => {
    throw new Error("the fake model is driven through the middleware only");
  },
};

const finishPart = (
  metadata: SharedV4ProviderMetadata,
  raw: JSONObject,
): LanguageModelV4StreamPart => ({
  type: "finish",
  usage: usageWith(raw),
  finishReason: { unified: "stop", raw: "stop" },
  providerMetadata: metadata,
});

/** Drive one finish part through the carrier and hand back what came out. */
const carryStream = async (
  part: LanguageModelV4StreamPart,
): Promise<LanguageModelV4StreamPart[]> => {
  const wrapStream = byokCostCarrierMiddleware.wrapStream;
  if (!wrapStream) throw new Error("the carrier must wrap streams");
  const { stream } = await wrapStream({
    doStream: () =>
      Promise.resolve({
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start: (controller) => {
            controller.enqueue(part);
            controller.close();
          },
        }),
      }),
    doGenerate: () => {
      throw new Error("unused");
    },
    params: { prompt: [] },
    model,
  });
  const out: LanguageModelV4StreamPart[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
};

describe("carrying the charge to where the readers can reach it", () => {
  /**
   * The reason this middleware exists at all. Verified against a live stream:
   * the provider puts its unsanitised usage on `usage.raw` at the model layer,
   * but the SDK core drops `raw` when it aggregates a step, so anything
   * reading a finished step — the turn ledger above all — sees no `is_byok`
   * and therefore no BYOK cost. `providerMetadata` survives that aggregation.
   */
  test("a BYOK finish part comes out with the charge on its metadata", async () => {
    const [out] = await carryStream(finishPart(META(0), BYOK_RAW));
    if (out?.type !== "finish") throw new Error("expected a finish part");
    const usage = out.providerMetadata?.openrouter?.usage;
    expect(usage).toMatchObject({ fretikByokUpstreamCostUsd: 0.0025935 });
  });

  test("the rest of the metadata survives the rewrite untouched", async () => {
    // The same block carries the serving provider and the token breakdown,
    // and four other readers depend on them. Adding a key may never drop one.
    const [out] = await carryStream(finishPart(META(0), BYOK_RAW));
    if (out?.type !== "finish") throw new Error("expected a finish part");
    const openrouter = out.providerMetadata?.openrouter;
    expect(openrouter?.provider).toBe("BaseTen");
    expect(openrouter?.reasoning_details).toEqual([]);
    expect(openrouter?.usage).toMatchObject({
      promptTokens: 33_051,
      completionTokens: 655,
      cost: 0,
    });
  });

  test("an ordinary call's metadata is handed back unchanged", async () => {
    const original = META(4.65e-6);
    const [out] = await carryStream(finishPart(original, ORDINARY_RAW));
    if (out?.type !== "finish") throw new Error("expected a finish part");
    expect(out.providerMetadata).toBe(original);
  });

  test("the generate path carries it too", async () => {
    const wrapGenerate = byokCostCarrierMiddleware.wrapGenerate;
    if (!wrapGenerate) throw new Error("the carrier must wrap generate");
    const result = await wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usageWith(BYOK_RAW),
          providerMetadata: META(0),
          warnings: [],
        }),
      doStream: () => {
        throw new Error("unused");
      },
      params: { prompt: [] },
      model,
    });
    expect(result.providerMetadata?.openrouter?.usage).toMatchObject({
      fretikByokUpstreamCostUsd: 0.0025935,
    });
  });

  /**
   * The end the whole change is for: a BYOK generation read $0 on every cost
   * surface, because each of them asks `extractOpenRouterReport` and it could
   * only see the aggregator's zero.
   */
  test("end to end, a BYOK call stops reading as free", async () => {
    const before = extractOpenRouterReport(META(0));
    expect(before.costUsd).toBe(0);

    const [out] = await carryStream(finishPart(META(0), BYOK_RAW));
    if (out?.type !== "finish") throw new Error("expected a finish part");
    const after = extractOpenRouterReport(out.providerMetadata);
    expect(after.costUsd).toBe(0.0025935);
    expect(after.byokUpstreamCostUsd).toBe(0.0025935);
    expect(after.servingProvider).toBe("baseten");
  });
});
