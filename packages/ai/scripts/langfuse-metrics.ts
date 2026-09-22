/**
 * Read cost, latency and token usage back out of Langfuse.
 *
 * ## Why this exists
 *
 * The v3 → v4 `events_only` migration took away three endpoints the repo used
 * to reach for — `GET /traces`, `GET /traces/{id}`, `GET /sessions` all answer
 * `404 "not available on deployments running in Langfuse v4 events_only mode"`
 * — and the conclusion drawn at the time was that v4 had stopped reporting
 * cost. It had not. Verified against langfuse 4.24.0 on 2026-09-18:
 *
 * | call                                    | v4 events_only |
 * | --------------------------------------- | -------------- |
 * | `api.observations.getMany(...)`          | works (v2)     |
 * | `api.metrics.metrics({ query })`         | works (v2)     |
 * | `api.trace.get(id)` / `api.sessions.*`   | 404            |
 *
 * An observation still carries `totalCost`, `usageDetails` (input, output,
 * `output_reasoning`, `input_cache_read`), `latency`, `metadata` and the
 * serving provider. The Metrics API aggregates all of it server-side. Nothing
 * was lost; only the endpoints moved.
 *
 * ## `fields` is opt-in, and `core` is smaller than it sounds
 *
 * `core` is id, traceId, startTime, endTime, projectId, parentObservationId,
 * type. **`name`, `sessionId` and `userId` are in `basic`** — so
 * `fields=core,usage` hands back rows whose `name` is `undefined`, and a
 * caller that filters on the name quietly gets nothing at all. Name every
 * group you intend to read. Passing no `fields` at all returns `core,basic`,
 * which is why the opposite symptom — names and no usage — is just as easy to
 * hit. `limit` maxes at 1 000; the pagination key is `meta.cursor`.
 *
 * ## Usage
 *
 *   bun --env-file=.env run scripts/langfuse-metrics.ts names [days] [limit]
 *       Cost, call count and p50/p95 latency per observation name. The first
 *       call to make when asking "what is this costing" or "what is slow".
 *
 *   bun --env-file=.env run scripts/langfuse-metrics.ts trace <traceId>
 *       Every generation of one trace: model, tokens in/out (reasoning split
 *       out), cost, latency, serving provider, finish reason.
 *
 *   bun --env-file=.env run scripts/langfuse-metrics.ts cache [days] [env]
 *       What the prompt cache is NOT returning, split by cause — a provider
 *       change (the cache was never there) against a prefix that moved (we
 *       broke it ourselves). The acceptance query for the sticky-routing and
 *       prompt-prefix work; see `runCache` for what each figure excludes.
 *
 *   bun --env-file=.env run scripts/langfuse-metrics.ts query '<json>'
 *       Raw v2 Metrics query passthrough, for anything the two above do not
 *       cover. Shape: { view, dimensions, metrics, filters, timeDimension,
 *       fromTimestamp, toTimestamp, orderBy }. `view` is one of "traces",
 *       "observations", "scores-numeric", "scores-boolean",
 *       "scores-categorical"; `measure` is one of "count", "latency",
 *       "totalCost", "totalTokens", "value"; `aggregation` is one of "count",
 *       "sum", "avg", "p50", "p95", "max", "histogram".
 *
 * ## A named parent reports ZERO cost, and that is not a bug
 *
 * `names` groups by the observation's OWN name, and Langfuse aggregates cost
 * only onto `generation`/`embedding` observations. A wrapper opened by
 * `withNamedTrace` is an `agent` observation, so `compaction`, `vectorize`,
 * `pre-extract` and the rest all report `cost 0.0000` on that row while the
 * `chat <model>` generations nested inside them carry the real money.
 *
 * To ask "what does X cost", group or filter by **`traceName`** instead — the
 * attribute `withNamedTrace` propagates to every descendant:
 *
 *   bun run langfuse:metrics -- query '{"view":"observations",
 *     "dimensions":[{"field":"traceName"}],
 *     "metrics":[{"measure":"totalCost","aggregation":"sum"},
 *                {"measure":"count","aggregation":"count"},
 *                {"measure":"latency","aggregation":"p95"}],
 *     "filters":[{"column":"traceName","operator":"=","value":"compaction","type":"string"}],
 *     "fromTimestamp":"…","toTimestamp":"…"}'
 *
 * Verified 2026-09-18: by `name`, compaction reported 5 calls and $0; by
 * `traceName`, the same window reported 11 observations and $0.0889.
 *
 * Cost is only as trustworthy as the boot line `[langfuse] … integrations=1`:
 * anything above 1 exports every model call that many times, and every number
 * here is that many times too high (`lib/langfuse.ts` warns on it).
 */
import { langfuseClient, langfuseEnabled } from "../src/lib/langfuse";

const client = langfuseClient;
if (!langfuseEnabled || client === undefined) {
  throw new Error(
    "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL must all be set.",
  );
}

const api = client.api;

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : n.toFixed(4);
const count = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : Math.round(n).toLocaleString();
const seconds = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;

/** One `metrics` row, whose columns are named `<aggregation>_<measure>`. */
type MetricRow = Record<string, unknown>;

const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" ? v : undefined;
const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? { ...v } : {};

const runNames = async (days: number, limit: number): Promise<void> => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const result = await api.metrics.metrics({
    query: JSON.stringify({
      view: "observations",
      dimensions: [{ field: "name" }],
      metrics: [
        { measure: "count", aggregation: "count" },
        { measure: "totalCost", aggregation: "sum" },
        { measure: "latency", aggregation: "p50" },
        { measure: "latency", aggregation: "p95" },
        { measure: "totalTokens", aggregation: "sum" },
      ],
      fromTimestamp: from.toISOString(),
      toTimestamp: to.toISOString(),
      orderBy: [{ field: "count_count", direction: "desc" }],
    }),
  });
  const rows: MetricRow[] = Array.isArray(result.data) ? result.data : [];
  console.log(
    `${rows.length.toString()} observation names over the last ${days.toString()} day(s)\n`,
  );
  console.log(
    `${"name".padEnd(46)} ${"calls".padStart(9)} ${"cost".padStart(10)} ${"tokens".padStart(12)} ${"p50".padStart(8)} ${"p95".padStart(8)}`,
  );
  for (const row of rows.slice(0, limit)) {
    console.log(
      [
        (asString(row["name"]) ?? "?").slice(0, 46).padEnd(46),
        count(asNumber(row["count_count"])).padStart(9),
        money(asNumber(row["sum_totalCost"])).padStart(10),
        count(asNumber(row["sum_totalTokens"])).padStart(12),
        seconds(asNumber(row["p50_latency"])).padStart(8),
        seconds(asNumber(row["p95_latency"])).padStart(8),
      ].join(" "),
    );
  }
};

const runTrace = async (traceId: string): Promise<void> => {
  const result = await api.observations.getMany({
    traceId,
    limit: 100,
    // `basic` is not optional decoration here: it carries `name`, and `core`
    // does not. Without it every row below prints `?` for its name, which
    // looks like Langfuse lost the data rather than like this call never
    // asked for it.
    fields: "core,basic,usage,cost,metadata",
  });
  const rows = result.data;
  console.log(`${rows.length.toString()} observations in trace ${traceId}\n`);
  for (const o of rows) {
    const md = asRecord(o.metadata);
    const usage = asRecord(o.usageDetails);
    const finish = md["attributes.gen_ai.response.finish_reasons"];
    const latencyMs =
      typeof o.latency === "number" ? o.latency * 1_000 : undefined;
    console.log(
      [
        o.startTime.slice(11, 19),
        (o.type ?? "?").padEnd(10),
        (o.name ?? "?").slice(0, 38).padEnd(38),
        `in=${count(asNumber(usage["input"]))}`.padEnd(12),
        `answer=${count(asNumber(usage["output_answer"]))}`.padEnd(15),
        `think=${count(asNumber(usage["output_reasoning"]))}`.padEnd(13),
        `cached=${count(asNumber(usage["input_cache_read"]))}`.padEnd(14),
        `cost=${money(o.totalCost)}`.padEnd(13),
        `lat=${seconds(latencyMs)}`.padEnd(11),
        `prov=${asString(md["servingProvider"]) ?? "-"}`.padEnd(16),
        `finish=${Array.isArray(finish) ? finish.join(",") : "-"}`,
      ].join(" "),
    );
  }
};

/**
 * What the prompt cache is NOT returning, and why — the acceptance query for
 * the sticky-routing and prompt-prefix work.
 *
 * Two independent causes, separated because they need different fixes. When a
 * call lands on a DIFFERENT upstream than the previous call of the same
 * conversation, the cache was never there to read: a provider's prompt cache is
 * its own. When it lands on the SAME upstream and still misses, the prefix we
 * sent changed — a volatile system-prompt suffix, or a tool list that grew
 * mid-turn.
 *
 * Both figures exclude anything the fix cannot reach: a gap past the upstream
 * TTL (5 min is the shortest in the fleet), and a call whose prompt SHRANK,
 * which is compaction rebuilding the history on purpose.
 *
 * The money column is self-referential on purpose, so it needs no price table
 * to go stale: it prices the lost tokens at the difference between the bucket's
 * own observed rate and the rate of the calls that DID hit a warm cache. It
 * answers "what would this window have cost if every call had been as warm as
 * the warm ones", which is the question the work is trying to close.
 *
 * Baseline, 7 days of production measured 2026-09-22: $19.35 spent, of which
 * $6.02 (31.1 %) recoverable — $3.14 to provider changes, $2.88 to prefix
 * churn. `cacheRead_{N+1} / input_N` sat at 0.54 and falling.
 */
const CACHE_TTL_GUARD_S = 300;

interface CacheBucket {
  calls: number;
  lostTokens: number;
  input: number;
  cached: number;
  cost: number;
}

const emptyBucket = (): CacheBucket => ({
  calls: 0,
  lostTokens: 0,
  input: 0,
  cached: 0,
  cost: 0,
});

const runCache = async (days: number, environment: string): Promise<void> => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  let cursor: string | undefined;
  const rows: Awaited<ReturnType<typeof api.observations.getMany>>["data"] = [];
  // `basic` carries `name` and `sessionId`; `core` carries neither. See the
  // header — asking for the wrong groups returns rows that look empty.
  for (let page = 0; page < 60; page++) {
    const result = await api.observations.getMany({
      type: "GENERATION",
      fromStartTime: from.toISOString(),
      toStartTime: to.toISOString(),
      limit: 1000,
      fields: "core,basic,usage,cost,metadata",
      ...(cursor === undefined ? {} : { cursor }),
    });
    rows.push(...result.data);
    cursor = result.meta.cursor;
    if (cursor === undefined || result.data.length === 0) break;
  }

  const chat = rows.filter(
    (o) =>
      (o.name ?? "").startsWith("chat ") &&
      o.sessionId !== undefined &&
      o.sessionId !== null &&
      o.environment === environment,
  );
  const spend = chat.reduce((sum, o) => sum + (o.totalCost ?? 0), 0);

  // One lane per (conversation, model): stickiness is keyed per model, so two
  // models in one conversation are two independent lanes.
  const lanes = new Map<string, typeof chat>();
  for (const o of chat) {
    const key = `${o.sessionId ?? ""}|${o.name ?? ""}`;
    const lane = lanes.get(key) ?? [];
    lane.push(o);
    lanes.set(key, lane);
  }

  const switched = emptyBucket();
  const prefix = emptyBucket();
  const warm = emptyBucket();
  let newTurnLost = 0;
  let inTurnLost = 0;
  /**
   * Kept per POSITION, and that separation is the whole value of the number.
   * Pooled over every consecutive pair it reads ~0.79 — a hair off target —
   * because the within-turn steps are warm at ~99 % and drown the signal. The
   * boundary between two TURNS is where the prefix actually breaks, and it sat
   * at 0.54 when this was written.
   */
  const ratio = { turn: { num: 0, den: 0 }, step: { num: 0, den: 0 } };

  for (const lane of lanes.values()) {
    lane.sort((a, b) => a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < lane.length; i++) {
      const prev = lane[i - 1];
      const cur = lane[i];
      if (prev === undefined || cur === undefined) continue;
      const prevIn = asNumber(asRecord(prev.usageDetails)["input"]) ?? 0;
      const curIn = asNumber(asRecord(cur.usageDetails)["input"]) ?? 0;
      const cached =
        asNumber(asRecord(cur.usageDetails)["input_cache_read"]) ?? 0;
      // A prompt that shrank is a rebuilt history, not a lost cache.
      if (curIn < prevIn) continue;
      const gapS =
        (new Date(cur.startTime).getTime() -
          new Date(prev.endTime ?? prev.startTime).getTime()) /
        1000;
      if (gapS > CACHE_TTL_GUARD_S) continue;

      const sameTurn = prev.traceId === cur.traceId;
      const slot = sameTurn ? ratio.step : ratio.turn;
      slot.num += cached;
      slot.den += prevIn;

      const changed =
        asRecord(prev.metadata)["servingProvider"] !==
        asRecord(cur.metadata)["servingProvider"];
      // Everything the previous call already sent was a prefix of this one, so
      // it was all cacheable. What was not read back is what was lost.
      const lost = Math.max(0, prevIn - cached);
      const bucket = lost === 0 ? warm : changed ? switched : prefix;
      bucket.calls += 1;
      bucket.lostTokens += lost;
      bucket.input += curIn;
      bucket.cached += cached;
      bucket.cost += cur.totalCost ?? 0;
      if (lost > 0) {
        if (prev.traceId === cur.traceId) inTurnLost += lost;
        else newTurnLost += lost;
      }
    }
  }

  const rate = (b: CacheBucket): number =>
    b.input > 0 ? (b.cost / b.input) * 1e6 : 0;
  const warmRate = rate(warm);
  const recoverable = (b: CacheBucket): number =>
    Math.max(0, (rate(b) - warmRate) * (b.input / 1e6));

  console.log(
    `\ncache decomposition — ${days.toString()} day(s), environment=${environment}`,
  );
  console.log(
    `chat generations: ${count(chat.length)}   spend: $${spend.toFixed(2)}\n`,
  );
  console.log(
    `${"cause".padEnd(38)} ${"calls".padStart(7)} ${"lost tokens".padStart(14)} ${"$/Mtok-in".padStart(10)} ${"recoverable".padStart(12)}`,
  );
  for (const [label, bucket] of [
    ["provider CHANGED (routing)", switched],
    ["same provider, prefix missed", prefix],
    ["cache hit in full (reference)", warm],
  ] as const) {
    console.log(
      [
        label.padEnd(38),
        count(bucket.calls).padStart(7),
        count(bucket.lostTokens).padStart(14),
        rate(bucket).toFixed(3).padStart(10),
        (bucket === warm ? "-" : `$${recoverable(bucket).toFixed(2)}`).padStart(
          12,
        ),
      ].join(" "),
    );
  }
  const total = recoverable(switched) + recoverable(prefix);
  console.log(
    `\nrecoverable total: $${total.toFixed(2)}` +
      (spend > 0 ? ` (${((total / spend) * 100).toFixed(1)} % of spend)` : ""),
  );
  console.log(
    `  lost at a NEW TURN : ${count(newTurnLost)} tokens\n` +
      `  lost WITHIN a turn : ${count(inTurnLost)} tokens`,
  );
  const asRatio = (r: { num: number; den: number }): string =>
    (r.den > 0 ? r.num / r.den : 0).toFixed(3);
  console.log(
    `\nacceptance ratio cacheRead[N+1] / input[N]` +
      `\n  across a TURN boundary : ${asRatio(ratio.turn)}   <- the gate, target > 0.8` +
      `\n  within one turn        : ${asRatio(ratio.step)}`,
  );
};

const USAGE =
  "usage: langfuse-metrics.ts names [days] [limit] | trace <traceId> | cache [days] [environment] | query '<json>'";

const [command, ...rest] = Bun.argv.slice(2);

if (command === "names") {
  await runNames(Number(rest[0] ?? "7"), Number(rest[1] ?? "40"));
} else if (command === "trace") {
  const traceId = rest[0];
  if (!traceId) throw new Error(USAGE);
  await runTrace(traceId);
} else if (command === "cache") {
  await runCache(Number(rest[0] ?? "7"), rest[1] ?? "production");
} else if (command === "query") {
  const raw = rest[0];
  if (!raw) throw new Error(USAGE);
  const result = await api.metrics.metrics({ query: raw });
  console.log(JSON.stringify(result.data, null, 2));
} else {
  throw new Error(USAGE);
}
