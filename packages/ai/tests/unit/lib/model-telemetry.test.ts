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
 * Passive telemetry runs on 100 % of model traffic, so these tests are mostly
 * about what it must NEVER do.
 *
 * Three invariants, in order of how much they would cost to get wrong:
 *
 *   - IT MAY NOT COST A TURN. A sink that is down, slow or throwing has to be
 *     invisible to the person waiting on their answer. Losing an hour of
 *     measurements costs the registry a little evidence; a rejected write
 *     reaching a stream costs a customer their reply.
 *   - NOTHING IS RECORDED WITHOUT A SUBJECT. These figures decide which hosts
 *     stay in a pool. A measurement averaged into "somebody" corrupts whoever
 *     it lands next to, which is worse than the gap it fills.
 *   - TTFT IS A FIRST-TOKEN MEASUREMENT, never a total duration wearing that
 *     name. The two are indistinguishable in a column and mean opposite
 *     things.
 */

interface RecordedCall {
  profileKey: string;
  provider: string;
  transport: string;
  durationMs: number;
  ttftMs?: number;
  outputTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  errored?: boolean;
}

interface FiledIncident {
  modelKey: string;
  provider: string;
  kind: string;
}

const recorded: RecordedCall[] = [];
const filed: FiledIncident[] = [];
let sinkRejects = false;

await mockModuleStrict("@fretik/shared/services/model-registry/telemetry", {
  recordCall: (input: RecordedCall): Promise<void> => {
    if (sinkRejects) return Promise.reject(new Error("redis is down"));
    recorded.push(input);
    return Promise.resolve();
  },
});
await mockModuleStrict("@fretik/shared/services/model-registry/breaker", {
  reportIncident: (input: FiledIncident): Promise<void> => {
    filed.push(input);
    return Promise.resolve();
  },
});

const { telemetryMiddleware } =
  await import("../../../src/lib/model-telemetry");

const usage = (output: number, input = 100): LanguageModelV4Usage => ({
  inputTokens: {
    total: input,
    noCache: input,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

const GATEWAY_META: SharedV4ProviderMetadata = {
  gateway: { routing: { resolvedProvider: "coreweave" }, cost: "0.004" },
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

const finish = (
  unified: LanguageModelV4FinishReason["unified"] = "stop",
  outputTokens = 200,
  providerMetadata: SharedV4ProviderMetadata | null = GATEWAY_META,
): LanguageModelV4StreamPart => ({
  type: "finish",
  usage: usage(outputTokens),
  finishReason: { unified, raw: unified },
  ...(providerMetadata === null ? {} : { providerMetadata }),
});

/**
 * Drive parts through `wrapStream` and drain. `{ advanceMs }` fakes the clock
 * forward — the stall detector reads wall time, and a test that actually
 * waited 45 s is not a test anyone runs.
 *
 * The stream is PULL-based on purpose. Enqueuing everything up front would
 * apply every offset before the transform saw a single part, so all of them
 * would read the same instant and every gap would measure zero — a harness
 * that passes whatever the detector does.
 */
const runStream = async (
  parts: (LanguageModelV4StreamPart | { advanceMs: number })[],
): Promise<void> => {
  const middleware = telemetryMiddleware({
    profileKey: "model-under-test",
    transport: "gateway",
  });
  const wrapStream = middleware.wrapStream;
  if (!wrapStream) throw new Error("telemetryMiddleware must wrap streams");

  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    let index = 0;
    const stream = new ReadableStream<LanguageModelV4StreamPart>(
      {
        pull: (controller) => {
          while (index < parts.length) {
            const part = parts[index];
            index += 1;
            if (part === undefined) continue;
            if ("advanceMs" in part) {
              offset += part.advanceMs;
              continue;
            }
            controller.enqueue(part);
            return;
          }
          controller.close();
        },
      },
      // No read-ahead. At the default high-water mark the stream fetches the
      // NEXT part while the transform is still handling the current one, so
      // the next `advanceMs` would already have moved the clock and every
      // measurement would be one part out of step.
      { highWaterMark: 0 },
    );
    const wrapped = await wrapStream({
      doStream: () => Promise.resolve({ stream }),
      doGenerate: () => {
        throw new Error("unused");
      },
      params: { prompt: [] },
      model,
    });
    for await (const part of wrapped.stream) void part;
  } finally {
    Date.now = realNow;
  }
  // Recording is fire-and-forget: a turn never waits on its own telemetry, and
  // neither does the assertion.
  await Promise.resolve();
};

beforeEach(() => {
  recorded.length = 0;
  filed.length = 0;
  sinkRejects = false;
});

describe("a turn never pays for its own telemetry", () => {
  test("a sink that rejects does not break the stream", async () => {
    sinkRejects = true;
    // The assertion is that this resolves at all: an unhandled rejection here
    // would surface as a failed generation for a customer whose answer was
    // already complete.
    await runStream([delta("hello"), finish()]);
    expect(recorded).toHaveLength(0);
  });

  test("every part still reaches the consumer", async () => {
    const middleware = telemetryMiddleware({
      profileKey: "model-under-test",
      transport: "gateway",
    });
    const wrapStream = middleware.wrapStream;
    if (!wrapStream) throw new Error("telemetryMiddleware must wrap streams");
    const { stream } = await wrapStream({
      doStream: () =>
        Promise.resolve({
          stream: new ReadableStream<LanguageModelV4StreamPart>({
            start: (controller) => {
              controller.enqueue(delta("a"));
              controller.enqueue(delta("b"));
              controller.enqueue(finish());
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
    const seen: string[] = [];
    for await (const part of stream) seen.push(part.type);
    expect(seen).toEqual(["text-delta", "text-delta", "finish"]);
  });
});

describe("attribution", () => {
  test("records against the host that actually served", async () => {
    await runStream([delta("hi"), finish()]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.provider).toBe("coreweave");
    expect(recorded[0]?.profileKey).toBe("model-under-test");
  });

  test("records NOTHING when no upstream is named", async () => {
    // A measurement with no subject cannot inform a pool decision, and folding
    // it into another host's numbers corrupts them.
    await runStream([delta("hi"), finish("stop", 200, null)]);
    expect(recorded).toHaveLength(0);
  });

  test("records nothing without a profile key", async () => {
    const middleware = telemetryMiddleware({ transport: "gateway" });
    const wrapGenerate = middleware.wrapGenerate;
    if (!wrapGenerate) throw new Error("must wrap generate");
    await wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(10),
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
    expect(recorded).toHaveLength(0);
  });
});

describe("what it measures", () => {
  test("TTFT is taken at the FIRST text delta, not at the end", async () => {
    await runStream([
      { advanceMs: 800 },
      delta("first"),
      { advanceMs: 4_000 },
      delta("later"),
      finish(),
    ]);
    const ttft = recorded[0]?.ttftMs;
    expect(ttft).toBeDefined();
    // Close to the 800 ms before the first token, and nowhere near the ~4.8 s
    // the whole call took — the distinction the field exists for.
    expect(ttft).toBeGreaterThanOrEqual(800);
    expect(ttft).toBeLessThan(2_000);
    expect(recorded[0]?.durationMs).toBeGreaterThanOrEqual(4_800);
  });

  test("a non-streamed call reports NO ttft", async () => {
    // There is no first token to observe, and recording the total duration
    // here would turn a latency percentile into a length percentile.
    const middleware = telemetryMiddleware({
      profileKey: "model-under-test",
      transport: "gateway",
    });
    const wrapGenerate = middleware.wrapGenerate;
    if (!wrapGenerate) throw new Error("must wrap generate");
    await wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: usage(50),
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
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.ttftMs).toBeUndefined();
    expect(recorded[0]?.outputTokens).toBe(50);
  });

  test("reasoning tokens count as output", async () => {
    // They are tokens the host decoded. Leaving them out would understate the
    // throughput of exactly the models that emit most of them.
    const middleware = telemetryMiddleware({
      profileKey: "model-under-test",
      transport: "gateway",
    });
    const wrapGenerate = middleware.wrapGenerate;
    if (!wrapGenerate) throw new Error("must wrap generate");
    await wrapGenerate({
      doGenerate: () =>
        Promise.resolve({
          content: [],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 10,
              noCache: 10,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 90, text: 40, reasoning: 50 },
          },
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
    expect(recorded[0]?.outputTokens).toBe(90);
  });

  test("the transport's reported cost is carried through", async () => {
    await runStream([delta("hi"), finish()]);
    expect(recorded[0]?.costUsd).toBeCloseTo(0.004, 6);
  });
});

describe("a stream that ends badly still counts", () => {
  test("a close with no finish part is recorded as an error, when it can be attributed", async () => {
    // The shape a cut takes on the wire. A host that cuts often should rank
    // below one that does not, and a pool ordered on successful calls alone
    // would never see it. In practice only `finish` carries the metadata, so
    // this is the one case telemetry can see it: a delta that named the host.
    await runStream([
      {
        type: "text-delta",
        id: "t1",
        delta: "half a sen",
        providerMetadata: GATEWAY_META,
      },
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.errored).toBe(true);
  });

  test("a cut with no metadata anywhere records nothing", async () => {
    // Honest blind spot, shared with `upstream-cut` for the same reason: a
    // stream that dies before naming its host leaves nothing to attribute,
    // and guessing would charge the failure to a bystander.
    await runStream([delta("half a sen")]);
    expect(recorded).toHaveLength(0);
  });

  test("one record per stream, never two", async () => {
    await runStream([delta("hi"), finish()]);
    expect(recorded).toHaveLength(1);
  });
});

describe("stall detection", () => {
  test("files a stall when the stream goes quiet mid-answer", async () => {
    // `stall` was declared with a threshold in the breaker and had no producer
    // at all until the TTFT tap gave it one for free.
    await runStream([
      delta("starting"),
      { advanceMs: 60_000 },
      delta("...finally"),
      finish(),
    ]);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.kind).toBe("stall");
    expect(filed[0]?.provider).toBe("coreweave");
  });

  test("a normal stream files nothing", async () => {
    await runStream([delta("a"), { advanceMs: 500 }, delta("b"), finish()]);
    expect(filed).toHaveLength(0);
  });

  test("files at most once per stream", async () => {
    // The breaker counts ROWS as distinct generations, so two rows from one
    // stream would let a single bad answer trip a quarantine on its own.
    await runStream([
      delta("a"),
      { advanceMs: 60_000 },
      delta("b"),
      { advanceMs: 60_000 },
      delta("c"),
      finish(),
    ]);
    expect(filed).toHaveLength(1);
  });

  test("a slow FIRST token is not a stall", async () => {
    // A cold start is latency, which TTFT already measures. A stall is a
    // stream that has begun and stopped.
    await runStream([{ advanceMs: 60_000 }, delta("finally"), finish()]);
    expect(filed).toHaveLength(0);
  });
});
