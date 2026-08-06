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
 *     one that does, and `sort: "throughput"` cannot see this at all. Measured
 *     by sending one byte-identical large prefix TWICE and reading
 *     `cached_tokens` off the second call.
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
import { MODEL_PROFILES } from "../src/lib/model-registry/profiles";

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
});

const chatResponseSchema = z.object({
  provider: z.string().nullish(),
  usage: usageSchema.nullish(),
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
  };

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
      return {
        ok: false,
        status: response.status,
        elapsedMs,
        servedBy: null,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        error: raw.slice(0, 160),
      };
    }

    const parsed = chatResponseSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return {
        ok: false,
        status: response.status,
        elapsedMs,
        servedBy: null,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        error: "unparseable response",
      };
    }
    const usage = parsed.data.usage;
    return {
      ok: true,
      status: response.status,
      elapsedMs,
      servedBy: parsed.data.provider ?? null,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      elapsedMs: performance.now() - started,
      servedBy: null,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      error: error instanceof Error ? error.message.slice(0, 160) : "unknown",
    };
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
 * Byte-stable filler for the cache probe. Must be IDENTICAL between the two
 * calls or the prefix cache cannot hit, so it is generated deterministically
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

const profileKey = parseFlag("profile");
if (!profileKey) {
  console.error(
    `--profile is required. Known profiles:\n  ${Object.keys(MODEL_PROFILES).join("\n  ")}`,
  );
  process.exit(2);
}

const profile = MODEL_PROFILES[profileKey];
if (!profile) {
  console.error(
    `Unknown profile "${profileKey}". Known profiles:\n  ${Object.keys(MODEL_PROFILES).join("\n  ")}`,
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

  // Cache probe: the same prefix twice. The FIRST call populates and is
  // expected to report 0 cached; only the second is evidence.
  const cacheMessages = [
    { role: "system", content: cachePrefix },
    { role: "user", content: "Reply with the single word: ok." },
  ];
  let cacheHitRatio: number | null = null;
  const warm = await callUpstream(
    modelId,
    provider,
    zdr,
    apiKey,
    cacheMessages,
    16,
    false,
  );
  if (warm.ok) {
    const second = await callUpstream(
      modelId,
      provider,
      zdr,
      apiKey,
      cacheMessages,
      16,
      false,
    );
    if (second.ok && second.promptTokens > 0) {
      cacheHitRatio = second.cachedTokens / second.promptTokens;
    }
  } else if (warm.status === 429) {
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
  `\n${"upstream".padEnd(16)}${"tok/s".padStart(8)}${"best".padStart(8)}${"total s".padStart(9)}${"output".padStart(8)}${"reason".padStart(8)}${"cache".padStart(8)}${"429".padStart(6)}${"fail".padStart(6)}`,
);
for (const row of [...rows].sort(
  (a, b) => (b.tpsMax ?? -1) - (a.tpsMax ?? -1),
)) {
  console.log(
    row.provider.padEnd(16) +
      fmt(row.tps, 1).padStart(8) +
      fmt(row.tpsMax, 1).padStart(8) +
      fmt(row.totalSeconds, 1).padStart(9) +
      fmt(row.outputTokens, 0).padStart(8) +
      fmt(row.reasoningTokens, 0).padStart(8) +
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
  "Cache % is the second of two identical prefixes; a low figure outweighs a high tok/s.",
);
console.log(
  "`best` is the ceiling. Read it against `tok/s`: a flat upstream is one the throughput sort can never usefully promote.",
);
