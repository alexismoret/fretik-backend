import type {
  LanguageModelV4,
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
} from "@ai-sdk/provider";
import { beforeEach, describe, expect, test } from "bun:test";
import { mockModuleStrict } from "../../lib/mock-module";

/**
 * The detectors are allowed to act automatically, so these are the tests that
 * earn that permission. Two invariants dominate:
 *
 *   - ONE INCIDENT PER GENERATION PER KIND. The breaker reads rows as distinct
 *     generations, so two rows from one stream would let a single bad answer
 *     trip a quarantine.
 *   - NOTHING IS FILED WITHOUT A SUBJECT. A quarantine removes a named host
 *     from a pool; an incident naming none is noise a human has to sift.
 *
 * Every invisible character is written as an escape on purpose — pasted
 * literally they are unreviewable, which is the whole point of the defect.
 */

interface FiledIncident {
  modelKey: string;
  provider: string;
  transport: string;
  kind: string;
  evidence?: Record<string, number | string>;
  generationId?: string;
}

const filed: FiledIncident[] = [];

await mockModuleStrict("@fretik/shared/services/model-registry/breaker", {
  reportIncident: (input: FiledIncident): Promise<void> => {
    filed.push(input);
    return Promise.resolve();
  },
});

const { detectorMiddleware } = await import("../../../src/lib/model-detectors");

const ZWSP = "\u{200B}";

const USAGE: LanguageModelV4Usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** The Gateway's own shape: the SERVING host, not the transport's name. */
const GATEWAY_META: SharedV4ProviderMetadata = {
  gateway: {
    routing: { resolvedProvider: "coreweave" },
    generationId: "gen-42",
  },
};

const OPENROUTER_META: SharedV4ProviderMetadata = {
  openrouter: { provider: "Together" },
};

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

const delta = (text: string): LanguageModelV4StreamPart => ({
  type: "text-delta",
  id: "t1",
  delta: text,
});

/** `null` metadata is a generation whose serving upstream nothing named. */
const finish = (
  unified: LanguageModelV4FinishReason["unified"],
  providerMetadata: SharedV4ProviderMetadata | null = GATEWAY_META,
): LanguageModelV4StreamPart => ({
  type: "finish",
  usage: USAGE,
  finishReason: { unified, raw: unified },
  ...(providerMetadata === null ? {} : { providerMetadata }),
});

const streamOf = (
  parts: LanguageModelV4StreamPart[],
): ReadableStream<LanguageModelV4StreamPart> =>
  new ReadableStream<LanguageModelV4StreamPart>({
    start: (controller) => {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });

/**
 * Drive one generation through `wrapStream` and drain it. Filing is
 * fire-and-forget, so the drain is followed by a microtask turn — a turn never
 * waits for its own monitoring, and neither does the assertion.
 */
const runStream = async (
  parts: LanguageModelV4StreamPart[],
  profileKey: string,
): Promise<void> => {
  const wrapStream = detectorMiddleware({ profileKey }).wrapStream;
  if (!wrapStream) throw new Error("detectorMiddleware must wrap streams");
  const { stream } = await wrapStream({
    doStream: () => Promise.resolve({ stream: streamOf(parts) }),
    doGenerate: () => {
      throw new Error("unused");
    },
    params: { prompt: [] },
    model,
  });
  for await (const part of stream) void part;
  await Promise.resolve();
};

beforeEach(() => {
  filed.length = 0;
});

describe("forbidden codepoints", () => {
  test("files one incident for the 2026-08-28 fixture, with the codepoint counts", async () => {
    // The measured injection lands on the NUMBERS: `Net 1.200, T.Net ␀4.800`.
    await runStream(
      [
        delta(`Net 1.200, T.Net ${ZWSP}4.800, Total ${ZWSP}314.88`),
        finish("stop"),
      ],
      "fixture",
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]?.kind).toBe("forbidden-codepoints");
    expect(filed[0]?.provider).toBe("coreweave");
    expect(filed[0]?.modelKey).toBe("fixture");
    expect(filed[0]?.transport).toBe("gateway");
    expect(filed[0]?.generationId).toBe("gen-42");
    expect(filed[0]?.evidence).toEqual({ "U+200B": 2, total: 2 });
  });

  test("files nothing for a clean stream", async () => {
    await runStream(
      [
        delta("Le total est de 314,88 € — facture réglée."),
        delta(" Créé le 12 août."),
        finish("stop"),
      ],
      "clean",
    );
    expect(filed).toHaveLength(0);
  });

  test("two hits in one generation are still exactly one incident", async () => {
    // The corroboration invariant. Split over two deltas so the accumulation
    // path is the one under test, not a single regex pass.
    await runStream(
      [
        delta(`Net 1.200${ZWSP}`),
        delta(`, T.Net ${ZWSP}4.800`),
        finish("stop"),
      ],
      "one-generation",
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]?.evidence).toEqual({ "U+200B": 2, total: 2 });
  });

  test("a second generation files a second incident", async () => {
    // The other half of the same invariant: the breaker's threshold means
    // separate ANSWERS, so separate calls must each be counted.
    await runStream([delta(`1.200${ZWSP}`), finish("stop")], "two-generations");
    await runStream([delta(`4.800${ZWSP}`), finish("stop")], "two-generations");
    expect(filed).toHaveLength(2);
  });

  test("reads the serving upstream from OpenRouter metadata too, normalised", async () => {
    await runStream(
      [delta(`Total ${ZWSP}314.88`), finish("stop", OPENROUTER_META)],
      "openrouter",
    );
    // NORMALISED, not verbatim. The two catalogues spell the same company
    // differently — `Together` here, `togetherai` on the gateway — and a
    // quarantine filed under one spelling excludes nobody from a pool written
    // in the other. Both are read through the transport adapters so the name
    // reaching the breaker is the name the pool uses.
    expect(filed[0]?.provider).toBe("together");
  });

  test("wrapGenerate sees the final text", async () => {
    const wrapGenerate = detectorMiddleware({
      profileKey: "non-streaming",
    }).wrapGenerate;
    if (!wrapGenerate) throw new Error("detectorMiddleware must wrap generate");
    await wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: "text", text: `Total ${ZWSP}314.88` }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE,
          providerMetadata: GATEWAY_META,
          warnings: [],
        }),
      doStream: () => {
        throw new Error("unused");
      },
      params: { prompt: [] },
      model,
    });
    await Promise.resolve();
    expect(filed).toHaveLength(1);
    expect(filed[0]?.kind).toBe("forbidden-codepoints");
  });
});

describe("think leak", () => {
  test("counts a closing tag split across two deltas once", async () => {
    await runStream(
      [
        delta("Voici le résumé.</thi"),
        delta("nk> Le total est de 314 €."),
        finish("stop"),
      ],
      "think-split",
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]?.kind).toBe("think-leak");
    expect(filed[0]?.evidence).toEqual({ tags: 1 });
  });

  test("files nothing when no tag reaches the content channel", async () => {
    await runStream(
      [delta("Je pense donc je suis."), finish("stop")],
      "think-clean",
    );
    expect(filed).toHaveLength(0);
  });
});

describe("truncated at tool call", () => {
  test("files when the text stops mid-sentence before the tool call", async () => {
    await runStream(
      [delta("Je vérifie la météo de Paris"), finish("tool-calls")],
      "cut-prose",
    );
    expect(filed).toHaveLength(1);
    expect(filed[0]?.kind).toBe("truncated-at-tool-call");
    expect(filed[0]?.evidence).toEqual({
      finishReason: "tool-calls",
      textLength: 28,
    });
  });

  test("files nothing when the turn hands off on a colon", async () => {
    // "let me check:" then a tool call is the ordinary shape of the path. If
    // this ever files, the detector is unusable.
    await runStream([delta("Je vérifie:"), finish("tool-calls")], "colon");
    expect(filed).toHaveLength(0);
  });

  test("files nothing after a complete sentence", async () => {
    await runStream(
      [delta("Je vérifie la météo de Paris."), finish("tool-calls")],
      "sentence",
    );
    expect(filed).toHaveLength(0);
  });

  test("files nothing when the turn emits no prose at all", async () => {
    await runStream([finish("tool-calls")], "silent-tool-call");
    expect(filed).toHaveLength(0);
  });

  test("files nothing when the text ends inside an unterminated code fence", async () => {
    await runStream(
      [delta("Voici le script:\n```python\ntotal = 314"), finish("tool-calls")],
      "fence",
    );
    expect(filed).toHaveLength(0);
  });
});

describe("attribution and rate limiting", () => {
  test("files nothing when providerMetadata names no upstream", async () => {
    await runStream(
      [delta(`Total ${ZWSP}314.88`), finish("stop", null)],
      "no-provider",
    );
    expect(filed).toHaveLength(0);
  });

  test("the token bucket stops the sixth filing in a minute", async () => {
    for (let i = 0; i < 7; i++) {
      await runStream([delta(`1.200${ZWSP}`), finish("stop")], "flood");
    }
    expect(filed).toHaveLength(5);
  });
});
