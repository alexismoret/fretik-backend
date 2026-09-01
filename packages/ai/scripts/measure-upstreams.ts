/**
 * Bench the UPSTREAMS that can serve one profile, so pool membership
 * (`assessment.provider.only`) is decided on evidence rather than on a
 * one-off note:
 *
 *     bun run models:bench -- --profile deepseek-v4-flash
 *     bun run models:bench -- --profile deepseek-v4-flash --providers baseten,siliconflow,novita --runs 5
 *
 * Needs `OPENROUTER_API_KEY`. Without `--providers` it benches the profile's
 * own `only` list; pass the flag to evaluate a candidate for admission.
 *
 * # Why this is not `models:check --probe`
 *
 * That probe asks "does this role route at all" with an 8-token completion.
 * This asks "should this upstream be in the pool", which is four separate
 * questions, none of which a short probe can answer:
 *
 *  1. **Sustained decode.** Throughput rises with output length, so anything
 *     under ~4k output tokens measures the handshake, not the decode an agent
 *     turn is actually made of. The clock therefore starts after the request is
 *     sent and stops after the whole body is read, n>=3, reported as a median —
 *     a single sample is what put Venice in the pool at "273 tok/s" when
 *     OpenRouter's own 30-minute aggregate says 33.
 *  2. **Cache population.** The heaviest term in a Fretik turn is cached input:
 *     a miss bills ~4.6x ($0.00490 vs $0.00107 measured). An upstream that is
 *     fast and never populates the implicit cache is a worse deal than a slower
 *     one that does, and `sort: "throughput"` cannot see this at all. Judged on
 *     BILLED COST, never on `cached_tokens`: that field is self-reported and an
 *     upstream may simply omit it, so a "0 %" reading is ambiguous where the
 *     price is not. Three byte-identical large prefixes go out; the first
 *     populates, and the cost of the cheapest later call against the first is
 *     the evidence. `cached_tokens` is still printed, as a hint only — the
 *     2026-08-06 audit found upstreams that cache while reporting nothing, and
 *     one (SiliconFlow) whose cache hit once then missed twice in 30 s, which a
 *     two-call probe cannot see at all.
 *  2b. **Answer integrity under tool calls.** An upstream may serve fast, cache
 *     well, and still MUTILATE the answer: Together was found on 2026-08-13 to
 *     stop emitting `content` mid-sentence as soon as it starts the
 *     `tool_calls` (44/50 prod turns cut, reproduced 3/3 here and identically
 *     non-streaming, so it is generation-side and nothing downstream can
 *     recover it). Every agent turn ends in a tool call, so this outranks every
 *     other column: an upstream that fails it is excluded whatever its speed.
 *     Measured by asking for one fixed sentence followed by a tool call and
 *     checking the sentence came back whole.
 *  3. **Reasoning convergence.** Novita and SiliconFlow were excluded for
 *     running to the cap with the answer still unwritten. Reasoning volume is a
 *     property of the prompt AND the serving stack, so it is read per upstream
 *     off `reasoning_tokens` against an explicit budget.
 *  4. **Availability.** BaseTen is the fastest endpoint in the pool and
 *     rate-limits us; a 429 inside `only` fails over silently, so the cost is
 *     invisible in production and shows up only as "why is it always DeepInfra".
 *     Counted here rather than inferred.
 *
 * Raw `fetch` rather than the AI SDK: every field that matters
 * (`cached_tokens`, `reasoning_tokens`, the serving `provider`, the HTTP status
 * behind a failure) is on the wire response, and pinning `only: [one]` per run
 * is the whole point — going through `resolveModel` would apply the profile's
 * pool instead of the single upstream under test.
 *
 * Prints a table and exits 0. It never edits a profile: widening a pool stays a
 * reviewed change, and the numbers belong in the profile's comment block
 * alongside the date they were taken.
 */
import { OPENROUTER_API_BASE_URL } from "@fretik/shared/lib/openrouter";
import { z } from "zod";
import { getEffectiveProfile } from "../src/lib/model-registry/effective";
import {
  listProfiles,
  warmModelRegistry,
} from "../src/lib/model-registry/resolve";

/**
 * Output cap for the decode runs. Below ~4k the measurement is dominated by
 * time-to-first-token and every upstream looks alike.
 */
const DECODE_MAX_TOKENS = 4_096;

/**
 * Reasoning budget for the decode runs. Deliberately small against
 * `DECODE_MAX_TOKENS`: the question is whether an upstream STOPS near it, not
 * whether it can reason.
 */
const REASONING_BUDGET_TOKENS = 600;

/**
 * Approximate prefix size for the cache probe, in tokens. Sized like a real
 * turn (system prompt + tools + skills measured at ~29k, plus history and
 * attachments) because some upstreams only cache above a minimum prefix.
 */
const CACHE_PREFIX_TOKENS = 75_000;

/** ~4 characters per token is close enough to size the filler. */
const CHARS_PER_TOKEN = 4;

/** A 4k-token generation on a slow upstream genuinely takes over a minute. */
const REQUEST_TIMEOUT_MS = 240_000;

const usageSchema = z.object({
  prompt_tokens: z.number().nullish(),
  completion_tokens: z.number().nullish(),
  prompt_tokens_details: z
    .object({ cached_tokens: z.number().nullish() })
    .nullish(),
  completion_tokens_details: z
    .object({ reasoning_tokens: z.number().nullish() })
    .nullish(),
  /** Billed dollars for this call — the only honest cache signal. */
  cost: z.number().nullish(),
});

const messageSchema = z.object({
  content: z.string().nullish(),
  tool_calls: z.array(z.unknown()).nullish(),
});

const chatResponseSchema = z.object({
  provider: z.string().nullish(),
  usage: usageSchema.nullish(),
  choices: z
    .array(
      z.object({
        message: messageSchema.nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .nullish(),
});

interface CallResult {
  ok: boolean;
  /** HTTP status, so a 429 is distinguishable from an empty pool's 404. */
  status: number;
  /** Wall clock from request sent to body fully read, ms. */
  elapsedMs: number;
  servedBy: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Billed dollars, `usage.cost`. 0 when the upstream reported none. */
  cost: number;
  /** Assistant text, needed by the integrity gate. */
  content: string;
  /** Whether the response ended on tool calls — the gate only reads those. */
  calledTool: boolean;
  error: string | null;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (upper === undefined) return null;
  return sorted.length % 2 === 1 || lower === undefined
    ? upper
    : (lower + upper) / 2;
};

/**
 * One completion pinned to a single upstream.
 *
 * The clock stops after `response.text()`, never at the headers: a streamed or
 * chunked body that is timed at the first byte measures TTFT and reports it as
 * throughput.
 */
const callUpstream = async (
  modelId: string,
  provider: string,
  zdr: boolean | undefined,
  apiKey: string,
  messages: readonly { role: string; content: string }[],
  maxTokens: number,
  withReasoningBudget: boolean,
  tools?: readonly unknown[],
): Promise<CallResult> => {
  const body = {
    model: modelId,
    messages,
    max_tokens: maxTokens,
    provider: {
      require_parameters: true,
      zdr,
      only: [provider],
    },
    usage: { include: true },
    ...(withReasoningBudget
      ? { reasoning: { enabled: true, max_tokens: REASONING_BUDGET_TOKENS } }
      : {}),
    ...(tools ? { tools, temperature: 0 } : {}),
  };

  const failed = (
    status: number,
    elapsedMs: number,
    error: string,
  ): CallResult => ({
    ok: false,
    status,
    elapsedMs,
    servedBy: null,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    content: "",
    calledTool: false,
    error,
  });

  const started = performance.now();
  try {
    const response = await fetch(
      `${OPENROUTER_API_BASE_URL}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const raw = await response.text();
    const elapsedMs = performance.now() - started;

    if (!response.ok) {
      return failed(response.status, elapsedMs, raw.slice(0, 160));
    }

    const parsed = chatResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return failed(response.status, elapsedMs, "unparseable response");
    }
    const usage = parsed.data.usage;
    const choice = parsed.data.choices?.[0];
    return {
      ok: true,
      status: response.status,
      elapsedMs,
      servedBy: parsed.data.provider ?? null,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      cost: usage?.cost ?? 0,
      content: choice?.message?.content ?? "",
      calledTool: (choice?.message?.tool_calls ?? []).length > 0,
      error: null,
    };
  } catch (error) {
    return failed(
      0,
      performance.now() - started,
      error instanceof Error ? error.message.slice(0, 160) : "unknown",
    );
  }
};

/**
 * Long-output task for the decode runs. Deliberately generic and self-contained
 * (no retrieval, no industry vocabulary) so the same prompt is comparable
 * across profiles, and open-ended enough that no upstream stops early — a run
 * that ends at 300 tokens measures nothing.
 */
const DECODE_PROMPT =
  "Write a thorough, well-structured technical explanation of how a write-ahead log works in a relational database: the durability guarantee, checkpointing, recovery after a crash, group commit, and the trade-offs against a shadow-paging design. Use headings and full paragraphs. Aim for at least 3000 words and do not stop early.";

/**
 * Integrity gate: one fixed sentence, then a tool call. Anything an upstream
 * drops off the end of `content` is a mutilated answer in production, where
 * every agent turn ends exactly like this. The sentence is deliberately short
 * and fully specified so the check is an equality, not a judgement.
 */
const INTEGRITY_SENTENCE = "Je vérifie la météo de Paris maintenant.";
const INTEGRITY_PROMPT = `Écris exactement cette phrase, mot pour mot, sans rien ajouter : « ${INTEGRITY_SENTENCE} » Puis appelle l'outil get_weather avec city=Paris.`;
const INTEGRITY_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  },
];

/** How many times the integrity gate is run per upstream. */
const INTEGRITY_RUNS = 3;

/**
 * Byte-stable filler for the cache probe. Must be IDENTICAL across the calls
 * or the prefix cache cannot hit, so it is generated deterministically
 * (no timestamps, no randomness) and reused rather than rebuilt per call.
 */
const buildCachePrefix = (): string => {
  const paragraph =
    "A distributed system coordinates independent processes over an unreliable network, and every guarantee it offers is paid for in latency, availability, or both. Consensus protocols exist to make a set of replicas agree on a single ordering of operations despite crashes and message loss. ";
  const target = CACHE_PREFIX_TOKENS * CHARS_PER_TOKEN;
  const repeats = Math.ceil(target / paragraph.length);
  return paragraph.repeat(repeats).slice(0, target);
};

const parseFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is not set.");
  process.exit(2);
}

// The registry lives in the database, so a script has to warm it before it can
// name a model.
await warmModelRegistry();
const known = (): string =>
  listProfiles()
    .map((p) => p.key)
    .sort()
    .join("\n  ");

const profileKey = parseFlag("profile");
if (!profileKey) {
  console.error(`--profile is required. Known profiles:\n  ${known()}`);
  process.exit(2);
}

const profile = getEffectiveProfile(profileKey);
if (!profile) {
  console.error(
    `Unknown profile "${profileKey}". Known profiles:\n  ${known()}`,
  );
  process.exit(2);
}

const providersFlag = parseFlag("providers");
const providers = providersFlag
  ? providersFlag
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  : [...(profile.assessment.provider.only ?? [])];

if (providers.length === 0) {
  console.error(
    `Profile "${profileKey}" declares no \`only\` pool — pass --providers a,b,c.`,
  );
  process.exit(2);
}

const runsFlag = parseFlag("runs");
const runs = runsFlag ? Number(runsFlag) : 3;
if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer.");
  process.exit(2);
}

const { zdr } = profile.assessment.provider;
const modelId = profile.catalog.id;
const cachePrefix = buildCachePrefix();

console.log(
  `Benching ${modelId} (profile ${profileKey}, zdr=${String(zdr ?? false)})`,
);
console.log(
  `${providers.length} upstream(s) x ${runs.toString()} decode run(s) of up to ${DECODE_MAX_TOKENS.toString()} tokens, plus a 2-call cache probe.\n`,
);

interface Row {
  provider: string;
  tps: number | null;
  /**
   * Best run, not an outlier to be discarded.
   *
   * The median answers "what do I usually get"; the CEILING answers "can this
   * upstream ever be worth routing to", and on this fleet the two disagree
   * completely. OpenRouter's own percentiles for deepseek-v4-flash have
   * DeepInfra at p50 44 / p99 104 against Venice at p50 41 / p99 304 — nearly
   * the same median, 3x the tail. A pool chosen on medians alone admits the
   * flattest endpoint and locks out the ones that actually go fast, which is
   * the whole reason this column exists.
   */
  tpsMax: number | null;
  totalSeconds: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cacheHitRatio: number | null;
  /** Billed cost of the first (cold) prefix call, dollars. */
  coldCost: number | null;
  /** Cheapest billed cost among the later identical calls, dollars. */
  warmCost: number | null;
  /** Integrity-gate passes out of `INTEGRITY_RUNS`. */
  intact: number;
  intactRuns: number;
  rateLimited: number;
  failures: number;
  firstError: string | null;
}

const rows: Row[] = [];

// oxlint-disable no-await-in-loop -- the serialisation IS the measurement
// Sequential across upstreams AND runs: two concurrent 4k generations share a
// client egress path and each would slow the other, which is exactly the signal
// being measured. A bench that parallelises measures the bench.
for (const provider of providers) {
  process.stdout.write(`${provider} … `);
  const tpsSamples: number[] = [];
  const totalSamples: number[] = [];
  const outputSamples: number[] = [];
  const reasoningSamples: number[] = [];
  let rateLimited = 0;
  let failures = 0;
  let firstError: string | null = null;

  for (let run = 0; run < runs; run += 1) {
    const result = await callUpstream(
      modelId,
      provider,
      zdr,
      apiKey,
      [{ role: "user", content: DECODE_PROMPT }],
      DECODE_MAX_TOKENS,
      true,
    );
    if (!result.ok) {
      failures += 1;
      if (result.status === 429) rateLimited += 1;
      firstError ??= `HTTP ${result.status.toString()} ${result.error ?? ""}`;
      continue;
    }
    // Guard against an upstream that answered in three sentences: dividing by a
    // tiny token count yields a throughput figure that is arithmetically valid
    // and meaningless.
    if (result.completionTokens < DECODE_MAX_TOKENS / 4) {
      firstError ??= `stopped early at ${result.completionTokens.toString()} output tokens`;
    }
    tpsSamples.push(result.completionTokens / (result.elapsedMs / 1000));
    totalSamples.push(result.elapsedMs / 1000);
    outputSamples.push(result.completionTokens);
    reasoningSamples.push(result.reasoningTokens);
  }

  // Integrity gate: does the answer survive a tool call? Run before the cache
  // probe because a failure here excludes the upstream whatever follows.
  let intact = 0;
  for (let run = 0; run < INTEGRITY_RUNS; run += 1) {
    const result = await callUpstream(
      modelId,
      provider,
      zdr,
      apiKey,
      [{ role: "user", content: INTEGRITY_PROMPT }],
      512,
      false,
      INTEGRITY_TOOLS,
    );
    if (!result.ok) {
      if (result.status === 429) rateLimited += 1;
      firstError ??= `integrity HTTP ${result.status.toString()}`;
      continue;
    }
    // A run that never called the tool did not exercise the gate; only a
    // response that DID switch to tool calls can show the truncation.
    if (!result.calledTool) {
      firstError ??= "integrity run made no tool call";
      continue;
    }
    if (result.content.includes(INTEGRITY_SENTENCE)) intact += 1;
    else
      firstError ??= `answer cut before the tool call: ${JSON.stringify(result.content.slice(-40))}`;
  }

  // Cache probe: the same prefix three times, judged on BILLED COST. The first
  // call populates; the cheapest of the rest is the evidence. Three rather than
  // two because an upstream can hit once and miss after (SiliconFlow did, twice
  // within 30 s), and a two-call probe reports that as a clean cache.
  const cacheMessages = [
    { role: "system", content: cachePrefix },
    { role: "user", content: "Reply with the single word: ok." },
  ];
  let cacheHitRatio: number | null = null;
  let coldCost: number | null = null;
  let warmCost: number | null = null;
  const cold = await callUpstream(
    modelId,
    provider,
    zdr,
    apiKey,
    cacheMessages,
    16,
    false,
  );
  if (cold.ok) {
    coldCost = cold.cost;
    for (let run = 0; run < 2; run += 1) {
      const repeat = await callUpstream(
        modelId,
        provider,
        zdr,
        apiKey,
        cacheMessages,
        16,
        false,
      );
      if (!repeat.ok) continue;
      warmCost =
        warmCost === null ? repeat.cost : Math.min(warmCost, repeat.cost);
      if (repeat.promptTokens > 0) {
        cacheHitRatio = Math.max(
          cacheHitRatio ?? 0,
          repeat.cachedTokens / repeat.promptTokens,
        );
      }
    }
  } else if (cold.status === 429) {
    rateLimited += 1;
  }

  rows.push({
    provider,
    tps: median(tpsSamples),
    tpsMax: tpsSamples.length > 0 ? Math.max(...tpsSamples) : null,
    totalSeconds: median(totalSamples),
    outputTokens: median(outputSamples),
    reasoningTokens: median(reasoningSamples),
    cacheHitRatio,
    coldCost,
    warmCost,
    intact,
    intactRuns: INTEGRITY_RUNS,
    rateLimited,
    failures,
    firstError,
  });
  console.log("done");
}

const fmt = (value: number | null, digits: number): string =>
  value === null ? "—" : value.toFixed(digits);

// Ranked by CEILING, not median: a pool exists to give `sort: "throughput"`
// candidates worth promoting when they are hot, and an upstream that never goes
// fast can never be one — however respectable its median.
console.log(
  `\n${"upstream".padEnd(16)}${"intact".padStart(8)}${"tok/s".padStart(8)}${"best".padStart(8)}${"total s".padStart(9)}${"output".padStart(8)}${"reason".padStart(8)}${"cold $".padStart(10)}${"warm $".padStart(10)}${"cache".padStart(8)}${"429".padStart(6)}${"fail".padStart(6)}`,
);
for (const row of [...rows].sort(
  (a, b) => (b.tpsMax ?? -1) - (a.tpsMax ?? -1),
)) {
  console.log(
    row.provider.padEnd(16) +
      `${row.intact.toString()}/${row.intactRuns.toString()}`.padStart(8) +
      fmt(row.tps, 1).padStart(8) +
      fmt(row.tpsMax, 1).padStart(8) +
      fmt(row.totalSeconds, 1).padStart(9) +
      fmt(row.outputTokens, 0).padStart(8) +
      fmt(row.reasoningTokens, 0).padStart(8) +
      fmt(row.coldCost, 5).padStart(10) +
      fmt(row.warmCost, 5).padStart(10) +
      (row.cacheHitRatio === null
        ? "—"
        : `${(row.cacheHitRatio * 100).toFixed(0)}%`
      ).padStart(8) +
      row.rateLimited.toString().padStart(6) +
      row.failures.toString().padStart(6),
  );
}

const noted = rows.filter((row) => row.firstError !== null);
if (noted.length > 0) {
  console.log("");
  for (const row of noted) {
    console.log(`note  ${row.provider}: ${row.firstError ?? ""}`);
  }
}

console.log(
  `\nReasoning budget was ${REASONING_BUDGET_TOKENS.toString()} tokens — an upstream far above it did not converge.`,
);
console.log(
  "`intact` is the gate: anything below the full count MUTILATES answers that end in a tool call — exclude it, whatever the other columns say.",
);
console.log(
  "Cache is `warm $` against `cold $` over identical prefixes. Read the PRICE, not the `cache` %: that column is self-reported and an upstream may cache while reporting nothing.",
);
console.log(
  "`best` is the ceiling. Read it against `tok/s`: a flat upstream is one the throughput sort can never usefully promote.",
);
