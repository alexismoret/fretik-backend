/**
 * What size do real conversations actually reach?
 *
 * ## Why this exists
 *
 * `AGENT_CONTEXT_CEILING_TOKENS` is the single number that decides when a turn
 * is cut and a history summarised, and until 2026-09-18 it was chosen from two
 * published sources and nothing else: Anthropic's `clear_tool_uses` default of
 * 100 000, and the measured accuracy fall between 64K and 128K (LOCA-bench,
 * Chroma "Context Rot"). Both are arguments about where accuracy goes. Neither
 * says how many of OUR turns are anywhere near it — and a threshold nobody's
 * traffic reaches costs nothing to raise, while one that half the traffic sits
 * on is the most expensive constant in the service.
 *
 * So this reads the answer off production rather than deriving it. Every
 * generation Langfuse holds carries `usageDetails.input`: the real request
 * size, per call, as the provider billed it — not an estimate, not a
 * reconstruction.
 *
 * ## What it reports, and why two views rather than one
 *
 * **Per call** answers the COST question. Raising the ceiling only costs money
 * on calls that would have been compacted and now are not, and their share of
 * traffic is what turns a per-token delta into a bill.
 *
 * **Per session peak** answers the USER question — "will this restrict
 * people". A conversation is restricted the moment its LARGEST turn crosses
 * the line, and counting calls instead would weight one long conversation the
 * same as fifty short ones.
 *
 * The two disagree by a lot, and each on its own argues for a different number.
 *
 * ## The `fields` trap, which cost this script one wrong run
 *
 * `fields` is an opt-in projection and `core` is NOT "the important ones": it
 * is id, traceId, startTime, endTime, projectId, parentObservationId, type —
 * and nothing else. `name` and `sessionId` live in `basic`, which the default
 * (no `fields` at all) includes and any explicit `fields` string silently
 * drops. Asking for `core,usage` therefore returns every generation with
 * `name === undefined`, so a prefix filter on the name matches nothing and the
 * script reports an empty dataset rather than an error. Ask for what you read.
 *
 * ## Reading it
 *
 *   bun --env-file=.env run scripts/measure-context-distribution.ts [days] [maxPages]
 *
 * Cost is only as trustworthy as the boot line `[langfuse] … integrations=1`
 * (`lib/langfuse.ts` warns otherwise); token counts are unaffected by that
 * multiplier, so the distribution stands either way.
 */
import { langfuseClient, langfuseEnabled } from "../src/lib/langfuse";

const client = langfuseClient;
if (!langfuseEnabled || client === undefined) {
  throw new Error(
    "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL must all be set.",
  );
}

/**
 * The boundaries the decision is actually about, in tokens of REQUEST — the
 * unit `AGENT_CONTEXT_CEILING_TOKENS` is written in, so a row here can be read
 * straight across to a candidate value.
 */
const BUCKETS = [
  0, 8_000, 16_000, 32_000, 64_000, 100_000, 150_000, 200_000, 300_000, 500_000,
] as const;

/**
 * Candidate ceilings, reported as "what share of traffic crosses this".
 *
 * 64 196 is not a ceiling but the HISTORY cap the 100 000 ceiling implies once
 * the measured prefix is subtracted; it is listed because it is the number the
 * compaction threshold actually compares against, and reading the two side by
 * side is the only way to see that they are one prefix apart on purpose.
 * 180 000 is the value the 2026-09-18 A/B was run at.
 */
const CANDIDATES = [64_196, 100_000, 150_000, 180_000, 200_000] as const;

interface Sample {
  /** Conversation, when the export carried one — the unit a user experiences. */
  sessionId: string | undefined;
  /** ISO start time — the simulation below needs calls in the order they happened. */
  startTime: string;
  input: number;
  cachedInput: number;
  cost: number;
  model: string;
  /** Which agent made the call — `chatbot`, `chatbot.page-builder`, … */
  agent: string | undefined;
}

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;

/**
 * Which agent a generation belongs to, and why it takes two passes.
 *
 * AI SDK v7 files the functionId as `gen_ai.agent.name` on the AGENT
 * observation ONLY, and the chain from there to the tokens is THREE levels,
 * not two:
 *
 *   invoke_agent <model>   AGENT       ← carries `gen_ai.agent.name`
 *     └ step 1             SPAN        ← carries nothing
 *         └ chat <model>   GENERATION  ← carries the tokens
 *
 * So the page builder, the dispatch sub-agent and the chat turn are
 * indistinguishable on the row that has the numbers, and recovering the
 * identity means walking `parentObservationId` upwards rather than reading it
 * off the row or off its immediate parent.
 *
 * Both shorter versions were measured and both report the same wrong answer —
 * one `(unattributed)` bucket of 63 000 rows, which looks like data.
 */
const AGENT_PREFIX = /^agent:/;

/** Deep enough for agent → step → generation, with room to spare. */
const MAX_PARENT_HOPS = 6;

const collect = async (
  days: number,
  maxPages: number,
): Promise<{ samples: Sample[]; attributed: number }> => {
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const pending: { sample: Sample; parentId: string | undefined }[] = [];
  const agentOf = new Map<string, string>();
  /** Every observation's parent, so the walk can cross the unnamed `step N`. */
  const parentOf = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    // Every type, not just GENERATION: the AGENT rows are what name the work,
    // and they arrive interleaved with (often after) their own children.
    const result = await client.api.observations.getMany({
      fromStartTime: from,
      // 1 000 is the documented maximum and the difference between a two-minute
      // read and a twenty-minute one.
      limit: 1_000,
      fields: "core,basic,usage,metadata",
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const o of result.data) {
      const metadata: Record<string, unknown> =
        typeof o.metadata === "object" && o.metadata !== null
          ? { ...o.metadata }
          : {};
      const agentRaw = metadata["attributes.gen_ai.agent.name"];
      if (typeof agentRaw === "string" && agentRaw.length > 0) {
        agentOf.set(o.id, agentRaw.replace(AGENT_PREFIX, ""));
      }
      if (o.parentObservationId) parentOf.set(o.id, o.parentObservationId);
      // `chat …` is the agent's own generation. Everything else in the export
      // — embeddings, rerank, the summariser itself — has a different size
      // distribution and would blur the one number this exists to produce.
      if (!(o.name ?? "").startsWith("chat ")) continue;
      const usage: Record<string, unknown> =
        typeof o.usageDetails === "object" && o.usageDetails !== null
          ? { ...o.usageDetails }
          : {};
      const input = asNumber(usage["input"]);
      if (input === undefined || input <= 0) continue;
      pending.push({
        parentId: o.parentObservationId ?? undefined,
        sample: {
          sessionId: o.sessionId ?? undefined,
          startTime: o.startTime,
          input,
          cachedInput: asNumber(usage["input_cache_read"]) ?? 0,
          cost: o.totalCost ?? 0,
          model: (o.name ?? "").slice(5),
          agent: undefined,
        },
      });
    }
    const next = result.meta.cursor;
    if (next === undefined || next === null || next === "") break;
    cursor = next;
    if (page % 5 === 4)
      console.log(
        `  … ${(page + 1).toString()} pages, ${pending.length.toString()} chat generations, ${agentOf.size.toString()} named parents`,
      );
  }
  // Second pass, once every parent that was going to arrive has.
  const walkToAgent = (start: string | undefined): string | undefined => {
    let id = start;
    for (let hop = 0; hop < MAX_PARENT_HOPS && id !== undefined; hop++) {
      const found = agentOf.get(id);
      if (found !== undefined) return found;
      id = parentOf.get(id);
    }
    return undefined;
  };
  let attributed = 0;
  const samples = pending.map(({ sample, parentId }) => {
    const agent = walkToAgent(parentId);
    if (agent !== undefined) attributed += 1;
    return agent === undefined ? sample : { ...sample, agent };
  });
  return { samples, attributed };
};

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[
        Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
      ] ?? 0);

const histogram = (values: number[], label: string, total: number): void => {
  console.log(`\n## ${label} (n=${values.length.toLocaleString()})\n`);
  console.log(
    `${"bucket".padEnd(22)} ${"n".padStart(8)} ${"share".padStart(8)} ${"cumul.".padStart(8)}`,
  );
  let cumulative = 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    const lo = BUCKETS[i] ?? 0;
    const hi = BUCKETS[i + 1];
    const n = values.filter(
      (v) => v >= lo && (hi === undefined || v < hi),
    ).length;
    cumulative += n;
    const name =
      hi === undefined
        ? `≥ ${(lo / 1000).toFixed(0)}K`
        : `${(lo / 1000).toFixed(0)}K – ${(hi / 1000).toFixed(0)}K`;
    console.log(
      [
        name.padEnd(22),
        n.toLocaleString().padStart(8),
        `${((n / total) * 100).toFixed(2)}%`.padStart(8),
        `${((cumulative / total) * 100).toFixed(2)}%`.padStart(8),
      ].join(" "),
    );
  }
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `\np50=${percentile(sorted, 50).toLocaleString()}  p90=${percentile(sorted, 90).toLocaleString()}  p95=${percentile(sorted, 95).toLocaleString()}  p99=${percentile(sorted, 99).toLocaleString()}  max=${(sorted.at(-1) ?? 0).toLocaleString()}`,
  );
};

const days = Number(Bun.argv[2] ?? "30");
const maxPages = Number(Bun.argv[3] ?? "120");

console.log(
  `Reading chat generations over ${days.toString()} day(s), up to ${maxPages.toString()} pages…\n`,
);
const { samples, attributed } = await collect(days, maxPages);
if (samples.length === 0) throw new Error("no chat generations found");

const perCall = samples.map((s) => s.input);

const peakBySession = new Map<string, number>();
for (const s of samples) {
  if (s.sessionId === undefined) continue;
  peakBySession.set(
    s.sessionId,
    Math.max(peakBySession.get(s.sessionId) ?? 0, s.input),
  );
}
const perSession = [...peakBySession.values()];

histogram(perCall, "Per CALL — request size as billed", perCall.length);
if (perSession.length > 0)
  histogram(
    perSession,
    "Per CONVERSATION peak — the largest single request it ever made",
    perSession.length,
  );
else
  console.log(
    "\n(no sessionId on any generation — per-conversation view skipped)",
  );

console.log(`\n## What each candidate ceiling would cut\n`);
console.log(
  `${"ceiling".padStart(10)} ${"calls over".padStart(12)} ${"share".padStart(8)} ${"convs over".padStart(12)} ${"share".padStart(8)}`,
);
for (const c of CANDIDATES) {
  const calls = perCall.filter((v) => v >= c).length;
  const convs = perSession.filter((v) => v >= c).length;
  console.log(
    [
      c.toLocaleString().padStart(10),
      calls.toLocaleString().padStart(12),
      `${((calls / perCall.length) * 100).toFixed(2)}%`.padStart(8),
      convs.toLocaleString().padStart(12),
      (perSession.length === 0
        ? "-"
        : `${((convs / perSession.length) * 100).toFixed(2)}%`
      ).padStart(8),
    ].join(" "),
  );
}

// The cache is what makes a bigger prefix affordable, so its hit rate is not a
// footnote: an uncached token costs full price and a re-read one a tenth of it.
const totalInput = samples.reduce((a, s) => a + s.input, 0);
const totalCached = samples.reduce((a, s) => a + s.cachedInput, 0);
console.log(
  `\ncache: ${totalCached.toLocaleString()} / ${totalInput.toLocaleString()} input tokens read from cache = ${((totalCached / totalInput) * 100).toFixed(1)}%`,
);

/**
 * What a ceiling is worth, in the only unit that decides it.
 *
 * `share of calls` above says how OFTEN a ceiling fires; it says nothing about
 * what it saves, because the calls it fires on are precisely the enormous
 * ones. A ceiling that touches 4 % of calls can still be holding back a third
 * of the token bill — or almost none of it — and the two cases argue for
 * opposite numbers.
 *
 * `excess` is the honest upper bound on the saving: for every call, the tokens
 * it carries ABOVE the ceiling. Real compaction saves more than that (it
 * replaces the history with a ~2 500-token summary rather than clamping it to
 * the line) and also spends more (a summariser call, plus whatever the agent
 * re-derives afterwards), so this brackets the decision from the generous
 * side: if a higher ceiling does not cost much excess, it certainly does not
 * cost much money.
 */
/**
 * Which agent gets big, which one never does.
 *
 * The ceiling is composed into EVERY agent by `buildToolLoopAgent`, so raising
 * it raises it for the dispatch sub-agent and the page builder too — and those
 * two answer the question "should they compact as well" with their own
 * numbers rather than with an argument about how they feel. An agent whose p99
 * is far below the line is one for which a compaction mechanism would be dead
 * code, and dead code that summarises is worse than none.
 */
console.log(
  `\n## By AGENT — who actually gets near the ceiling (${attributed.toLocaleString()}/${samples.length.toLocaleString()} attributed)\n`,
);
console.log(
  `${"agent".padEnd(28)} ${"calls".padStart(8)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"p99".padStart(9)} ${"max".padStart(10)} ${"≥180K".padStart(7)}`,
);
const byAgent = new Map<string, number[]>();
for (const s of samples) {
  const key = s.agent ?? "(unattributed)";
  const list = byAgent.get(key);
  if (list) list.push(s.input);
  else byAgent.set(key, [s.input]);
}
for (const [agent, values] of [...byAgent.entries()].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  const sorted = [...values].sort((a, b) => a - b);
  const over = values.filter((v) => v >= 180_000).length;
  console.log(
    [
      agent.slice(0, 28).padEnd(28),
      values.length.toLocaleString().padStart(8),
      percentile(sorted, 50).toLocaleString().padStart(9),
      percentile(sorted, 95).toLocaleString().padStart(9),
      percentile(sorted, 99).toLocaleString().padStart(9),
      (sorted.at(-1) ?? 0).toLocaleString().padStart(10),
      `${((over / values.length) * 100).toFixed(2)}%`.padStart(7),
    ].join(" "),
  );
}

console.log(`\n## What each ceiling holds back, in tokens (upper bound)\n`);
console.log(
  `${"ceiling".padStart(10)} ${"excess tokens".padStart(16)} ${"of all input".padStart(13)} ${"vs 100K".padStart(9)}`,
);
const excessAt = (c: number): number =>
  perCall.reduce((a, v) => a + Math.max(0, v - c), 0);
const baseline = excessAt(100_000);
for (const c of CANDIDATES) {
  const excess = excessAt(c);
  console.log(
    [
      c.toLocaleString().padStart(10),
      Math.round(excess).toLocaleString().padStart(16),
      `${((excess / totalInput) * 100).toFixed(2)}%`.padStart(13),
      `${excess >= baseline ? "" : "-"}${((Math.abs(excess - baseline) / totalInput) * 100).toFixed(2)} pt`.padStart(
        9,
      ),
    ].join(" "),
  );
}

/**
 * What the bill would ACTUALLY have been, conversation by conversation.
 *
 * The excess figure above answers a different question than the one being
 * asked. It assumes a ceiling clamps a call to the line; compaction does not
 * clamp, it CUTS — a 300 000-token history is replaced by a ~2 500-token
 * summary, so the calls after a cut are far below the ceiling rather than at
 * it, and the saving is correspondingly larger. In the other direction the
 * excess figure ignores what a cut COSTS: the summariser reads the whole
 * history it is about to replace.
 *
 * So this replays each conversation's calls in the order they happened and
 * applies the mechanism: carry a running reduction, subtract it from each
 * observed size, and when what is left crosses the ceiling, cut to the floor
 * and charge a summariser pass over what was cut. The result is comparable
 * across ceilings because every arm replays the same observed traffic.
 *
 * Two honest limits. The observed sizes come from traffic that ran WITHOUT a
 * ceiling, so a cut changes what the agent would have done next and the replay
 * cannot know that — it assumes the same sequence of turns. And the summariser
 * is charged at input parity with the agent, which overstates it: the
 * summariser runs on a cheaper model than most chat turns.
 */
const FLOOR_TOKENS = 38_000;
const SUMMARY_OUTPUT_TOKENS = 2_500;

console.log(`\n## Simulated bill, replaying every conversation\n`);
console.log(
  `${"ceiling".padStart(10)} ${"input tokens".padStart(16)} ${"vs no ceiling".padStart(14)} ${"compactions".padStart(12)}`,
);

const bySession = new Map<string, Sample[]>();
for (const s of samples) {
  if (s.sessionId === undefined) continue;
  const list = bySession.get(s.sessionId);
  if (list) list.push(s);
  else bySession.set(s.sessionId, [s]);
}
for (const list of bySession.values())
  list.sort((a, b) => a.startTime.localeCompare(b.startTime));

const simulate = (
  ceiling: number | undefined,
): { tokens: number; cuts: number } => {
  let tokens = 0;
  let cuts = 0;
  for (const list of bySession.values()) {
    let reduction = 0;
    for (const call of list) {
      const effective = Math.max(FLOOR_TOKENS, call.input - reduction);
      if (ceiling === undefined || effective <= ceiling) {
        tokens += effective;
        continue;
      }
      // The summariser reads what is about to be replaced, then the turn runs
      // on the floor.
      tokens += effective + SUMMARY_OUTPUT_TOKENS;
      cuts += 1;
      reduction += effective - FLOOR_TOKENS;
      tokens += FLOOR_TOKENS;
    }
  }
  return { tokens, cuts };
};

const uncapped = simulate(undefined);
console.log(
  [
    "none".padStart(10),
    Math.round(uncapped.tokens).toLocaleString().padStart(16),
    "100%".padStart(14),
    "0".padStart(12),
  ].join(" "),
);
for (const c of CANDIDATES) {
  const sim = simulate(c);
  console.log(
    [
      c.toLocaleString().padStart(10),
      Math.round(sim.tokens).toLocaleString().padStart(16),
      `${((sim.tokens / uncapped.tokens) * 100).toFixed(1)}%`.padStart(14),
      sim.cuts.toLocaleString().padStart(12),
    ].join(" "),
  );
}
