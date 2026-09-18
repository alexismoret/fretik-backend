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
 *   bun --env-file=.env run scripts/langfuse-metrics.ts runs [rootName] [days] [environment]
 *       Where one KIND of run spends its clock and its money, attributed to
 *       leaves so the shares add up. Defaults to `workflow-turn`, 7 days,
 *       `production`.
 *
 *   bun --env-file=.env run scripts/langfuse-metrics.ts trace <traceId>
 *       Every generation of one trace: model, tokens in/out (reasoning split
 *       out), cost, latency, serving provider, finish reason.
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
 * Where a RUN's wall clock and money go — the question `names` cannot answer.
 *
 * Two things make this its own command rather than another Metrics query.
 *
 * **Scope.** `names` aggregates the whole environment, and chat traffic
 * outnumbers workflow runs by more than ten to one, so an unsplit table
 * describes the chatbot wearing a workflow's name. This one starts from the
 * turns of ONE root name and reads only their traces.
 *
 * **Leaves.** A parent's seconds are its children's. `workflow-turn`,
 * `invoke_agent` and `step N` each contain the calls nested inside them, so
 * their latencies overlap and cannot be summed — sorting a "where does the time
 * go" table by total puts every parent on top and answers nothing. Attributing
 * a second only to observations that are nobody's parent makes the column add
 * up, and the Metrics API has no notion of a leaf, so it is computed here.
 *
 * Measured this way on 2026-09-16, over 13 turns of 10 production runs: the
 * model generating was 91% of the attributed clock and the sandbox 3%.
 */
const runRuns = async (
  turnName: string,
  days: number,
  environment: string,
): Promise<void> => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const FIELDS = "core,basic,usage,cost";
  // The environment filter is not optional tidiness. Measured 2026-09-18 over
  // three days: 97 `workflow-turn` unfiltered, 36 production and 61 the
  // developer's own machine. Unfiltered, this table blends somebody's laptop
  // into a production figure and nothing says so.
  const turns = await api.observations.getMany({
    name: turnName,
    environment,
    fromStartTime: from.toISOString(),
    toStartTime: to.toISOString(),
    limit: 1000,
    fields: FIELDS,
  });
  if (turns.data.length === 0) {
    console.log(`No "${turnName}" in the last ${days.toString()} day(s).`);
    return;
  }

  const sessions = new Map<string, number>();
  const turnLatencies: number[] = [];
  for (const turn of turns.data) {
    if (typeof turn.latency === "number") turnLatencies.push(turn.latency);
    // A run is its conversation, which is the session. Falling back to the
    // trace id counts a session-less turn as its own run rather than folding
    // every one of them into a single phantom run keyed `null`.
    const key = turn.sessionId ?? turn.traceId ?? turn.id;
    sessions.set(key, (sessions.get(key) ?? 0) + (turn.latency ?? 0));
  }
  const q = (values: readonly number[], p: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return (
      sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0
    );
  };
  const runClocks = [...sessions.values()];
  console.log(
    `\n"${turnName}" — ${sessions.size.toString()} runs, ${turns.data.length.toString()} turns, last ${days.toString()} day(s)`,
  );
  console.log(
    `  turn latency: p50 ${seconds(q(turnLatencies, 0.5) * 1000)}  p90 ${seconds(q(turnLatencies, 0.9) * 1000)}  max ${seconds(q(turnLatencies, 1) * 1000)}`,
  );
  console.log(
    `  run clock:    p50 ${seconds(q(runClocks, 0.5) * 1000)}  p90 ${seconds(q(runClocks, 0.9) * 1000)}  max ${seconds(q(runClocks, 1) * 1000)}`,
  );

  // One call per trace. With runs counted in tens this is cheaper than sweeping
  // the environment, and unlike a sweep it cannot silently truncate its window.
  const traceIds = [
    ...new Set(
      turns.data
        .map((t) => t.traceId)
        .filter((v): v is string => typeof v === "string"),
    ),
  ].slice(0, 60);
  interface Leaf {
    calls: number;
    latency: number;
    cost: number;
  }
  const leaves = new Map<string, Leaf>();
  let totalLatency = 0;
  let totalCost = 0;
  for (const traceId of traceIds) {
    const page = await api.observations.getMany({
      traceId,
      environment,
      limit: 1000,
      fields: FIELDS,
    });
    const parents = new Set(
      page.data
        .map((o) => o.parentObservationId)
        .filter((v): v is string => typeof v === "string"),
    );
    for (const o of page.data) {
      if (parents.has(o.id)) continue;
      const name = o.name ?? `(${o.type ?? "unnamed"})`;
      const leaf = leaves.get(name) ?? { calls: 0, latency: 0, cost: 0 };
      leaf.calls++;
      leaf.latency += o.latency ?? 0;
      leaf.cost += o.totalCost ?? 0;
      leaves.set(name, leaf);
      totalLatency += o.latency ?? 0;
      totalCost += o.totalCost ?? 0;
    }
  }

  console.log(
    `\n  ${"spent by (leaves only)".padEnd(40)} ${"calls".padStart(7)} ${"seconds".padStart(9)} ${"share".padStart(6)} ${"cost".padStart(10)}`,
  );
  for (const [name, leaf] of [...leaves.entries()]
    .sort(([, a], [, b]) => b.latency - a.latency)
    .slice(0, 15)) {
    const share =
      totalLatency === 0
        ? "-"
        : `${((leaf.latency / totalLatency) * 100).toFixed(0)}%`;
    console.log(
      `  ${name.slice(0, 40).padEnd(40)} ${count(leaf.calls).padStart(7)} ${leaf.latency.toFixed(0).padStart(8)}s ${share.padStart(6)} ${money(leaf.cost).padStart(10)}`,
    );
  }
  console.log(
    `\n  ${traceIds.length.toString()} traces read, ${totalLatency.toFixed(0)}s attributed, ${money(totalCost)} total.`,
  );
  console.log(
    `  Every second is attributed once, to the observation that actually spent it.\n`,
  );
};

const USAGE =
  "usage: langfuse-metrics.ts names [days] [limit] | runs [rootName] [days] [environment] | trace <traceId> | query '<json>'";

const [command, ...rest] = Bun.argv.slice(2);

if (command === "names") {
  await runNames(Number(rest[0] ?? "7"), Number(rest[1] ?? "40"));
} else if (command === "runs") {
  await runRuns(
    rest[0] ?? "workflow-turn",
    Number(rest[1] ?? "7"),
    rest[2] ?? "production",
  );
} else if (command === "trace") {
  const traceId = rest[0];
  if (!traceId) throw new Error(USAGE);
  await runTrace(traceId);
} else if (command === "query") {
  const raw = rest[0];
  if (!raw) throw new Error(USAGE);
  const result = await api.metrics.metrics({ query: raw });
  console.log(JSON.stringify(result.data, null, 2));
} else {
  throw new Error(USAGE);
}
