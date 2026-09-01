import { describe, expect, test } from "bun:test";
import type {
  CatalogueCapabilities,
  CatalogueEntry,
  CatalogueSource,
} from "../../src/model-registry/catalogue";
import {
  catalogueMatchKey,
  mergeCatalogues,
} from "../../src/model-registry/catalogue";
import type { TransportId } from "../../src/model-registry/types";

/**
 * The catalogue merge: one model as every transport that serves it describes it.
 *
 * The rules under test all exist because the three catalogues disagree in ways
 * that are not errors. They spell the creator differently (`alibaba/qwen3-max`
 * against `qwen/qwen3-max`), they publish different columns, and — the case
 * that forced the sizing rule — they quote genuinely different CONTEXT WINDOWS,
 * because the window is a property of what a transport accepts rather than of
 * the weights.
 */

const capabilities = (
  over: Partial<CatalogueCapabilities> = {},
): CatalogueCapabilities => ({
  identifiesModelType: false,
  publishesModalities: false,
  publishesOwner: false,
  publishesReleaseDate: false,
  publishesZdrHint: false,
  publishesReasoningContract: false,
  publishesPercentiles: false,
  publishesToolChoice: false,
  publishesUptime: false,
  ...over,
});

const source = (
  id: TransportId,
  over: Partial<CatalogueCapabilities> = {},
): CatalogueSource => ({
  id,
  capabilities: capabilities(over),
  listModels: () => Promise.resolve([]),
  fetchEndpoints: () => Promise.resolve([]),
});

const entry = (
  over: Partial<CatalogueEntry> & { id: string },
): CatalogueEntry => ({
  name: over.id,
  description: "",
  owner: "unknown",
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: [],
  pricing: {},
  ...over,
});

describe("catalogueMatchKey", () => {
  test("the creator segment is discarded, the model segment folded", () => {
    expect(catalogueMatchKey("alibaba/qwen3-max")).toBe(
      catalogueMatchKey("qwen/qwen3-max"),
    );
    expect(catalogueMatchKey("spacexai/grok-4.5")).toBe(
      catalogueMatchKey("x-ai/grok-4.5"),
    );
    // A bare id — Scaleway spells every model without a creator.
    expect(catalogueMatchKey("glm-5.2")).toBe(catalogueMatchKey("zai/glm-5.2"));
  });
});

describe("mergeCatalogues", () => {
  test("a model gets its id on every transport that serves it", () => {
    const merged = mergeCatalogues([
      { source: source("gateway"), entries: [entry({ id: "zai/glm-5.2" })] },
      {
        source: source("openrouter"),
        entries: [entry({ id: "z-ai/glm-5.2" })],
      },
      { source: source("scaleway"), entries: [entry({ id: "glm-5.2" })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.idsByTransport).toEqual({
      gateway: "zai/glm-5.2",
      openrouter: "z-ai/glm-5.2",
      scaleway: "glm-5.2",
    });
  });

  test("a capability beats an inference, whichever order they arrive in", () => {
    const declared = {
      source: source("openrouter", { publishesModalities: true }),
      entries: [
        entry({ id: "x/m", inputModalities: ["text", "image", "audio"] }),
      ],
    };
    const inferred = {
      source: source("gateway"),
      entries: [entry({ id: "x/m", inputModalities: ["text"] })],
    };
    expect(mergeCatalogues([inferred, declared])[0]?.inputModalities).toEqual([
      "text",
      "image",
      "audio",
    ]);
    expect(mergeCatalogues([declared, inferred])[0]?.inputModalities).toEqual([
      "text",
      "image",
      "audio",
    ]);
  });

  test("two publishers narrow to the modalities both accept", () => {
    // Measured 2026-08-30: OpenRouter serves `qwen3.5-397b-a17b` with video
    // input, Scaleway serves the same model without it. Claiming video on a
    // Scaleway-routed turn sends a part the host rejects; omitting it costs a
    // native path that already falls back to the `read` / `vision` tools.
    const withVideo = {
      source: source("openrouter", { publishesModalities: true }),
      entries: [
        entry({ id: "q/397b", inputModalities: ["text", "image", "video"] }),
      ],
    };
    const withoutVideo = {
      source: source("scaleway", { publishesModalities: true }),
      entries: [entry({ id: "397b", inputModalities: ["text", "image"] })],
    };
    for (const listings of [
      [withVideo, withoutVideo],
      [withoutVideo, withVideo],
    ]) {
      expect(mergeCatalogues(listings)[0]?.inputModalities.sort()).toEqual([
        "image",
        "text",
      ]);
    }
  });

  test("an INFERRED list never narrows a published one", () => {
    // The gateway reads modalities from two tags, so it cannot express audio at
    // all. Its silence is ignorance, not a refusal, and intersecting with it
    // would delete the one modality only one catalogue can see.
    const [merged] = mergeCatalogues([
      {
        source: source("openrouter", { publishesModalities: true }),
        entries: [entry({ id: "x/m", inputModalities: ["text", "audio"] })],
      },
      { source: source("gateway"), entries: [entry({ id: "x/m" })] },
    ]);
    expect(merged?.inputModalities).toEqual(["text", "audio"]);
  });

  test("the SMALLEST context window wins, not the last one read", () => {
    // The live case: Scaleway caps `deepseek-v4-flash-0731` at 256k during
    // preview while an aggregator advertises the weights' 997,952. Sizing
    // requests against the larger number is a failed request on every turn that
    // lands on the smaller host; sizing against the smaller is one more
    // compaction round. The old rule let whichever source was registered last
    // decide, so the fleet's context numbers moved with the source order.
    const big = {
      source: source("openrouter"),
      entries: [
        entry({ id: "d/v4-flash", contextWindow: 997_952, maxTokens: 65_536 }),
      ],
    };
    const capped = {
      source: source("scaleway"),
      entries: [
        entry({ id: "v4-flash", contextWindow: 256_000, maxTokens: 32_000 }),
      ],
    };
    for (const listings of [
      [big, capped],
      [capped, big],
    ]) {
      const [merged] = mergeCatalogues(listings);
      expect(merged?.contextWindow).toBe(256_000);
      expect(merged?.maxTokens).toBe(32_000);
    }
  });

  test("a size only one catalogue quotes is kept rather than dropped", () => {
    const [merged] = mergeCatalogues([
      { source: source("gateway"), entries: [entry({ id: "x/m" })] },
      {
        source: source("scaleway"),
        entries: [entry({ id: "m", contextWindow: 128_000 })],
      },
    ]);
    expect(merged?.contextWindow).toBe(128_000);
  });

  test("retirement takes EVERY serving catalogue, not one", () => {
    // Scaleway winds `qwen3-coder-30b-a3b-instruct` down while OpenRouter still
    // ships it. That is a reason to route elsewhere, not to stop discovering
    // the model — and a source that publishes no lifecycle says nothing, which
    // does not agree.
    const [shared] = mergeCatalogues([
      { source: source("openrouter"), entries: [entry({ id: "q/coder-30b" })] },
      {
        source: source("scaleway"),
        entries: [entry({ id: "coder-30b", deprecated: true })],
      },
    ]);
    expect(shared?.deprecated).toBe(false);

    const [alone] = mergeCatalogues([
      {
        source: source("scaleway"),
        entries: [entry({ id: "pixtral-12b-2409", deprecated: true })],
      },
    ]);
    expect(alone?.deprecated).toBe(true);
  });

  test("supported parameters are unioned across transports", () => {
    const [merged] = mergeCatalogues([
      {
        source: source("gateway"),
        entries: [entry({ id: "x/m", supportedParameters: ["tools"] })],
      },
      {
        source: source("scaleway"),
        entries: [entry({ id: "m", supportedParameters: ["reasoning"] })],
      },
    ]);
    expect(merged?.supportedParameters.sort()).toEqual(["reasoning", "tools"]);
  });

  test("an ambiguous folded name is dropped, never resolved", () => {
    // Two different ids folding to one name inside ONE catalogue is exactly the
    // case where a guess routes one vendor's traffic to another's model.
    const merged = mergeCatalogues([
      {
        source: source("gateway"),
        entries: [entry({ id: "acme/m-1" }), entry({ id: "other/m1" })],
      },
    ]);
    expect(merged).toHaveLength(0);
  });

  test("the model type comes only from a catalogue that classifies", () => {
    const [merged] = mergeCatalogues([
      {
        source: source("gateway", { identifiesModelType: true }),
        entries: [entry({ id: "x/m", isLanguageModel: true })],
      },
      // Publishes no `type` at all: its silence must not overwrite a verdict.
      { source: source("openrouter"), entries: [entry({ id: "x/m" })] },
    ]);
    expect(merged?.isLanguageModel).toBe(true);
  });
});
