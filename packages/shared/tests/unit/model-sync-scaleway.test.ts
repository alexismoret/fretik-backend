import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createScalewaySource } from "../../src/services/model-registry/sync/sources/scaleway-catalog";
import { fetchScalewayModelSpecs } from "../../src/services/model-registry/sync/sources/scaleway-model-specs";
import { fetchScalewayProductFacts } from "../../src/services/model-registry/sync/sources/scaleway-product-catalog";

/**
 * The Scaleway source, which takes three fetches to describe one model.
 *
 * Every payload below is shaped from a live response on 2026-08-30, and the
 * three-way split is not an accident of implementation — it is what Scaleway
 * publishes where:
 *
 *  - `/v1/models` returns `{id, object, created, owned_by}` and nothing else,
 *    so on its own a model arrives with no price, no modalities and no size;
 *  - the product catalogue prices it and, in `properties.generative_apis`,
 *    names its tasks, its APIs, its author and its reasoning scale;
 *  - only the published specifications carry the context window, and that
 *    number is SCALEWAY'S rather than the model's.
 *
 * The last point is the one with teeth: `deepseek-v4-flash-0731` answers to
 * 256k here against the 997,952 an aggregator advertises, so a context
 * inherited from the merge would size every request 3.9× over the real limit.
 */

const realFetch = globalThis.fetch;

const CATALOG = "api.scaleway.com/product-catalog";
const MODELS = "api.scaleway.ai";
const SPECS = "raw.githubusercontent.com";

const urlOf = (input: string | URL | Request): string => {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
};

/** Stands in for a source that is down, distinctly from one that says nothing. */
const FAIL: unique symbol = Symbol("upstream 503");

/** Route each host to its own body; `FAIL` answers 503, `undefined` 404. */
const serve = (bodies: {
  models?: unknown;
  catalog?: unknown;
  specs?: string | typeof FAIL;
}): void => {
  const stub = (input: string | URL | Request): Promise<Response> => {
    const url = urlOf(input);
    const pick = url.includes(CATALOG)
      ? bodies.catalog
      : url.includes(MODELS)
        ? bodies.models
        : url.includes(SPECS)
          ? bodies.specs
          : undefined;
    if (pick === undefined)
      return Promise.resolve(new Response("not found", { status: 404 }));
    if (pick === FAIL)
      return Promise.resolve(new Response("upstream down", { status: 503 }));
    return Promise.resolve(
      typeof pick === "string" ? new Response(pick) : Response.json(pick),
    );
  };
  globalThis.fetch = Object.assign(stub, {
    preconnect: realFetch.preconnect.bind(realFetch),
  });
};

const modelList = (ids: string[]): unknown => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", owned_by: "Scaleway" })),
});

/** One SKU. Prices are EUR per `size` tokens, exactly as the catalogue quotes. */
const sku = (over: {
  product: string;
  tokenType: string;
  eurPer1k?: number;
  tasks?: string[];
  apis?: string[];
  owner?: string;
  reasoning?: boolean;
  mode?: string;
  status?: string;
  unit?: { unit: string; size: number };
}): unknown => ({
  sku: `/ai/generative_apis/consumption/${over.product}_${over.tokenType}/fr-par`,
  product: over.product,
  product_category: "Generative APIs",
  status: over.status ?? "general_availability",
  unit_of_measure: over.unit ?? { unit: "token", size: 1000 },
  price:
    over.eurPer1k === undefined
      ? {}
      : {
          retail_price: {
            currency_code: "EUR",
            units: Math.floor(over.eurPer1k),
            nanos: Math.round((over.eurPer1k % 1) * 1e9),
          },
        },
  properties: {
    generative_apis: {
      provider_name: over.owner ?? "Zai",
      tasks: over.tasks ?? ["chat"],
      supported_apis: over.apis ?? ["/v1/chat/completions"],
      reasoning: over.reasoning ?? false,
      token_type: over.tokenType,
      consumption_mode: over.mode ?? "realtime",
    },
  },
});

const catalogPage = (products: unknown[]): unknown => ({
  products,
  total_count: products.length,
});

/** The two tables the specifications page carries, in its real MDX shape. */
const specsDoc = (
  rows: { id: string; modalities: string; context: string }[],
  sections: { id: string; tools: string; output: string }[] = [],
): string =>
  [
    "## Models technical summary",
    "| Model name | Available in Serverless? | Modalities | Maximum context window (tokens) | License\\* |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| [${row.id}](#anchor) | Yes | ${row.modalities} | ${row.context} | [MIT](https://x) |`,
    ),
    "",
    ...sections.flatMap((section) => [
      `### ${section.id}`,
      "| Attribute | Value |",
      "|---|---|",
      `| Supports structured output | ${section.tools} |`,
      `| Supports function calling | ${section.tools} |`,
      `| Maximum output (tokens) - Serverless | ${section.output} |`,
      "",
    ]),
  ].join("\n");

beforeEach(() => {
  process.env.SCW_SECRET_KEY = "test-scw-key";
  process.env.SCW_PROJECT_ID = "test-project";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env.SCW_SECRET_KEY = "test-scw-key";
  process.env.SCW_PROJECT_ID = "test-project";
});

describe("product catalogue", () => {
  test("EUR per 1k tokens becomes USD per million", async () => {
    // 0.0018 €/1k is what `glm-5.2` quotes, and 1.80 €/M is what the published
    // price table says — the two agree, which is what makes the unit reading
    // right. The USD figure is that times the reviewed rate.
    serve({
      catalog: catalogPage([
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
        sku({
          product: "glm-5.2",
          tokenType: "output_token",
          eurPer1k: 0.0055,
        }),
      ]),
    });
    const facts = await fetchScalewayProductFacts();
    expect(facts.get("glm-5.2")?.pricing).toEqual({
      inputPerMTok: 2.16,
      outputPerMTok: 6.6,
    });
  });

  test("the batch list never sets the price", async () => {
    // Batch is half price under the SAME `product`. Reading it would understate
    // every model by 50 % — and understating is the direction that quietly
    // spends money, because the budget cap is what reads this number.
    serve({
      catalog: catalogPage([
        sku({
          product: "glm-5.2",
          tokenType: "input_token",
          eurPer1k: 0.0009,
          mode: "batch",
        }),
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
      ]),
    });
    expect(
      (await fetchScalewayProductFacts()).get("glm-5.2")?.pricing.inputPerMTok,
    ).toBe(2.16);
  });

  test("a cached-input rate is carried, and audio-per-minute is not", async () => {
    serve({
      catalog: catalogPage([
        sku({
          product: "deepseek-v4-flash-0731",
          tokenType: "input_cached_token",
          eurPer1k: 0.00008,
        }),
        // Priced per 60 SECONDS of audio. Read as tokens it would invent a rate
        // three orders of magnitude out.
        sku({
          product: "whisper-large-v3",
          tokenType: "input_duration",
          eurPer1k: 0.003,
          unit: { unit: "second", size: 60 },
          tasks: ["audio_transcription"],
          apis: ["/v1/audio/transcriptions"],
        }),
      ]),
    });
    const facts = await fetchScalewayProductFacts();
    expect(
      facts.get("deepseek-v4-flash-0731")?.pricing.cacheReadPerMTok,
    ).toBeCloseTo(0.096, 6);
    expect(facts.get("whisper-large-v3")?.pricing).toEqual({});
  });

  test("tasks and APIs are unioned across a model's SKUs", async () => {
    serve({
      catalog: catalogPage([
        sku({
          product: "qwen3.6-35b-a3b",
          tokenType: "input_token",
          eurPer1k: 0.00025,
          tasks: ["chat", "code"],
        }),
        sku({
          product: "qwen3.6-35b-a3b",
          tokenType: "output_token",
          eurPer1k: 0.0015,
          tasks: ["chat", "vision"],
          reasoning: true,
        }),
      ]),
    });
    const facts = await fetchScalewayProductFacts();
    expect(facts.get("qwen3.6-35b-a3b")?.tasks.sort()).toEqual([
      "chat",
      "code",
      "vision",
    ]);
    expect(facts.get("qwen3.6-35b-a3b")?.reasoning).toBe(true);
  });

  test("a status past its feature life marks the model deprecated", async () => {
    serve({
      catalog: catalogPage([
        sku({
          product: "pixtral-12b-2409",
          tokenType: "input_token",
          eurPer1k: 0.0002,
          status: "end_of_new_features",
        }),
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
      ]),
    });
    const facts = await fetchScalewayProductFacts();
    expect(facts.get("pixtral-12b-2409")?.deprecated).toBe(true);
    expect(facts.get("glm-5.2")?.deprecated).toBe(false);
  });

  test("rows from other product categories are ignored", async () => {
    // The endpoint ignores every category filter probed, so the 5,300 unrelated
    // products arrive with ours and are dropped here or not at all.
    serve({
      catalog: catalogPage([
        {
          sku: "/instance/snapshot/l_ssd/fr-par-1",
          product: "Instance Local SSD Snapshot",
          product_category: "Instance",
          price: { retail_price: { currency_code: "EUR", nanos: 26_000 } },
        },
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
      ]),
    });
    expect([...(await fetchScalewayProductFacts()).keys()]).toEqual([
      "glm-5.2",
    ]);
  });

  test("no credentials means an empty map and no call", async () => {
    delete process.env.SCW_SECRET_KEY;
    let called = false;
    globalThis.fetch = Object.assign(
      (): Promise<Response> => {
        called = true;
        return Promise.resolve(Response.json({}));
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    );
    expect((await fetchScalewayProductFacts()).size).toBe(0);
    expect(called).toBe(false);
  });

  test("an unreadable price list is empty, never fatal", async () => {
    serve({ catalog: FAIL });
    expect((await fetchScalewayProductFacts()).size).toBe(0);
  });
});

describe("published specifications", () => {
  test("the serverless figure wins where a cell offers two", async () => {
    serve({
      specs: specsDoc([
        {
          id: "llama-3.3-70b-instruct",
          modalities: "Text",
          context: "100k (Serverless)/ 128k (Dedicated)",
        },
      ]),
    });
    expect(
      (await fetchScalewayModelSpecs()).get("llama-3.3-70b-instruct")
        ?.contextWindow,
    ).toBe(100_000);
  });

  test("footnote markers are stripped rather than parsed", async () => {
    // `256k\*\*` carries the preview caveat. The asterisks are MDX escapes.
    serve({
      specs: specsDoc([
        { id: "glm-5.2", modalities: "Text, Code", context: "256k\\*\\*" },
      ]),
    });
    expect(
      (await fetchScalewayModelSpecs()).get("glm-5.2")?.contextWindow,
    ).toBe(256_000);
  });

  test("a model with no context window is recorded with none, not zero", async () => {
    serve({
      specs: specsDoc([
        {
          id: "whisper-large-v3",
          modalities: "Audio transcription",
          context: "-",
        },
      ]),
    });
    expect((await fetchScalewayModelSpecs()).has("whisper-large-v3")).toBe(
      false,
    );
  });

  test("tool support and output cap come from the model's own section", async () => {
    serve({
      specs: specsDoc(
        [{ id: "glm-5.2", modalities: "Text, Code", context: "256k" }],
        [{ id: "Glm-5.2", tools: "Yes", output: "16k" }],
      ),
    });
    const spec = (await fetchScalewayModelSpecs()).get("glm-5.2");
    expect(spec).toMatchObject({
      contextWindow: 256_000,
      maxTokens: 16_000,
      supportsTools: true,
      supportsStructuredOutput: true,
    });
  });

  test("an unreadable page yields nothing rather than a fabricated size", async () => {
    // The consequence is deliberate and stated: no context window means the
    // model fails every context floor and is never promoted. A reformatting
    // withdraws Scaleway models from candidacy; it cannot invent a limit.
    serve({ specs: FAIL });
    expect((await fetchScalewayModelSpecs()).size).toBe(0);
  });
});

describe("the composed source", () => {
  const fullFleet = (): void =>
    serve({
      models: modelList(["glm-5.2", "pixtral-12b-2409", "qwen3-embedding-8b"]),
      catalog: catalogPage([
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
        sku({
          product: "glm-5.2",
          tokenType: "output_token",
          eurPer1k: 0.0055,
        }),
        sku({
          product: "pixtral-12b-2409",
          tokenType: "input_token",
          eurPer1k: 0.0002,
          tasks: ["chat", "vision"],
          owner: "Mistral",
        }),
        sku({
          product: "pixtral-12b-2409",
          tokenType: "output_token",
          eurPer1k: 0.0002,
          tasks: ["chat", "vision"],
          owner: "Mistral",
        }),
        sku({
          product: "qwen3-embedding-8b",
          tokenType: "input_token",
          eurPer1k: 0.0001,
          tasks: ["embeddings"],
          apis: ["/v1/embeddings"],
          owner: "Qwen",
        }),
      ]),
      specs: specsDoc(
        [
          { id: "glm-5.2", modalities: "Text, Code", context: "256k" },
          {
            id: "pixtral-12b-2409",
            modalities: "Text, Vision",
            context: "128k",
          },
          {
            id: "qwen3-embedding-8b",
            modalities: "Embeddings",
            context: "32k",
          },
        ],
        [
          { id: "Glm-5.2", tools: "Yes", output: "16k" },
          { id: "Pixtral-12b-2409", tools: "Yes", output: "4k" },
          { id: "Qwen3-embedding-8b", tools: "No", output: "-" },
        ],
      ),
    });

  test("a vision model gets its image modality as a FACT", async () => {
    fullFleet();
    const entries = await createScalewaySource().listModels();
    const pixtral = entries.find((e) => e.id === "pixtral-12b-2409");
    expect(pixtral?.inputModalities).toEqual(["text", "image"]);
    expect(pixtral?.owner).toBe("Mistral");
  });

  test("an embedding model is identified as not a language model", async () => {
    fullFleet();
    const entries = await createScalewaySource().listModels();
    expect(
      entries.find((e) => e.id === "qwen3-embedding-8b")?.isLanguageModel,
    ).toBe(false);
    expect(entries.find((e) => e.id === "glm-5.2")?.isLanguageModel).toBe(true);
  });

  test("the endpoint carries Scaleway's own context, not the model's", async () => {
    fullFleet();
    const [endpoint] = await createScalewaySource().fetchEndpoints("glm-5.2");
    expect(endpoint).toMatchObject({
      provider: "scaleway",
      contextLength: 256_000,
      maxCompletionTokens: 16_000,
      hasZdr: true,
    });
    expect(endpoint?.pricing.inputPerMTok).toBe(2.16);
  });

  test("no throughput is reported, and none is invented", async () => {
    // Scaleway publishes no percentiles. A zero would read as a measured
    // standstill and sink the model in every speed-ranked picker.
    fullFleet();
    const [endpoint] = await createScalewaySource().fetchEndpoints("glm-5.2");
    expect(endpoint?.throughputP50).toBeUndefined();
    expect(endpoint?.uptime1d).toBeUndefined();
  });

  test("a model with no context window gets no endpoint at all", async () => {
    serve({
      models: modelList(["glm-5.2"]),
      catalog: catalogPage([
        sku({ product: "glm-5.2", tokenType: "input_token", eurPer1k: 0.0018 }),
        sku({
          product: "glm-5.2",
          tokenType: "output_token",
          eurPer1k: 0.0055,
        }),
      ]),
      specs: FAIL,
    });
    const source = createScalewaySource();
    expect(await source.listModels()).toHaveLength(1);
    expect(await source.fetchEndpoints("glm-5.2")).toEqual([]);
  });

  test("an unreadable served list THROWS rather than reading as empty", async () => {
    // An empty list would record every Scaleway row as delisted in one pass.
    serve({ models: FAIL, catalog: catalogPage([]), specs: specsDoc([]) });
    // Explicit try/catch, not `.rejects.toThrow()` — Bun types that matcher as
    // synchronous, so the await lints away and the assertion silently stops
    // running.
    let thrown: unknown;
    try {
      await createScalewaySource().listModels();
    } catch (err: unknown) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("scaleway models GET failed");
  });

  test("the three fetches happen once for the whole pass", async () => {
    fullFleet();
    let calls = 0;
    const inner = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request): Promise<Response> => {
        calls += 1;
        return inner(input);
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    );
    const source = createScalewaySource();
    await source.listModels();
    await source.fetchEndpoints("glm-5.2");
    await source.fetchEndpoints("pixtral-12b-2409");
    expect(calls).toBe(3);
  });
});
