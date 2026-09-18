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

const USAGE =
  "usage: langfuse-metrics.ts names [days] [limit] | trace <traceId> | query '<json>'";

const [command, ...rest] = Bun.argv.slice(2);

if (command === "names") {
  await runNames(Number(rest[0] ?? "7"), Number(rest[1] ?? "40"));
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
