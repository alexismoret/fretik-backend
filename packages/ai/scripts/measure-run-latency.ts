/**
 * Where does a run's WALL CLOCK go?
 *
 *     bun run measure:run-latency
 *     bun run measure:run-latency -- --days 14 --env production --name workflow-turn
 *
 * The other half of tier 0's measurement, and the half the database cannot
 * answer. `workflow_runs.usage` now says how many steps a run took and which
 * tools it called; it says nothing about how long any of it took, because
 * nothing persists per-step timing. Langfuse does: every observation carries
 * `latency` and `timeToFirstToken`, and the model calls carry their exact cost.
 *
 * Speed is the stated priority of the whole plan, ahead of tokens, so this is
 * the instrument that decides what to work on. A run that spends forty percent
 * of its clock in the sandbox is a different problem from one that spends it
 * waiting on the model, and no count of tool calls distinguishes them.
 *
 * **Read-only, and it never asks for the payloads.** The observations endpoint
 * returns timing and names — not `input` or `output` — so the customer's
 * business data never reaches this process at all. What is printed is
 * quantiles, shares and counts.
 *
 * **Langfuse's own API, never its Postgres.** The instance is self-hosted, so
 * its database is reachable; its schema is an implementation detail of somebody
 * else's product, and the API answers the same question.
 *
 * # Two things this endpoint does NOT give, checked against the live API
 *
 * **Cost.** `inputPrice` / `outputPrice` / `totalPrice` come back `null` on
 * every row of the list view, generations included. Summing them prints
 * `$0.00`, which reads as "free" rather than as "not answered" — so no cost is
 * reported here at all. Cost lives on the single-observation endpoint and in
 * the Langfuse dashboard.
 *
 * **Time to first token.** `timeToFirstToken` is `null` on the rows that
 * matter, and the `ttft` span the chat handler emits is a zero-duration marker
 * whose value rides in attributes the list view does not return. Reporting its
 * `latency` would print a column of honest-looking zeroes.
 *
 * `latency` itself is in SECONDS, verified against `endTime - startTime` on
 * real rows rather than assumed — reading it as milliseconds made a five-minute
 * workflow turn print as 0.3 s.
 */

const BASE = process.env.LANGFUSE_BASE_URL;
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY;
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY;

if (
  BASE === undefined ||
  PUBLIC_KEY === undefined ||
  SECRET_KEY === undefined
) {
  console.error(
    "Set LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY (packages/ai/.env).",
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const equals = argv.find((a) => a.startsWith(`${name}=`));
  if (equals !== undefined) return equals.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

const daysRaw = Number.parseInt(opt("--days") ?? "", 10);
const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 7;
const environment = opt("--env") ?? "production";
/** Which root names count as "a run's turn" for the session rollup. */
const turnName = opt("--name") ?? "workflow-turn";
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

/** Only the fields the endpoint actually returns, and only those we read. */
interface Observation {
  id: string;
  name: string | null;
  type: string | null;
  environment: string | null;
  sessionId: string | null;
  traceId: string | null;
  parentObservationId: string | null;
  startTime: string | null;
  /** SECONDS — verified equal to `endTime - startTime` on live rows. */
  latency: number | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const toObservation = (raw: unknown): Observation | null => {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === null) return null;
  return {
    id,
    name: str(raw.name),
    type: str(raw.type),
    environment: str(raw.environment),
    sessionId: str(raw.sessionId),
    traceId: str(raw.traceId),
    parentObservationId: str(raw.parentObservationId),
    startTime: str(raw.startTime),
    latency: num(raw.latency),
  };
};

const auth = `Basic ${Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64")}`;

/**
 * Page through the window.
 *
 * The endpoint returns a cursor rather than a total, so the only way to know
 * the window is exhausted is to ask until a page comes back short. `--days`
 * bounds it; `MAX_PAGES` bounds a mistake.
 */
const maxRaw = Number.parseInt(opt("--max") ?? "", 10);
const MAX_OBSERVATIONS =
  Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 20_000;
const PAGE = 100;

/** Set when the budget ran out before the window did — reported, never hidden. */
let truncated = false;

const fetchObservations = async (): Promise<Observation[]> => {
  const all: Observation[] = [];
  let cursor: string | undefined;
  for (let page = 0; page * PAGE < MAX_OBSERVATIONS; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE),
      environment,
      fromStartTime: since,
    });
    if (cursor !== undefined) params.set("cursor", cursor);
    const response = await fetch(
      `${BASE}/api/public/v2/observations?${params.toString()}`,
      { headers: { Authorization: auth } },
    );
    if (!response.ok) {
      console.error(
        `Langfuse answered ${response.status.toString()} — stopping with ${all.length.toString()} observations.`,
      );
      break;
    }
    const body: unknown = await response.json();
    const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
    for (const raw of data) {
      const observation = toObservation(raw);
      if (observation !== null) all.push(observation);
    }
    const meta = isRecord(body) ? body.meta : undefined;
    const next = isRecord(meta) ? str(meta.cursor) : null;
    if (data.length < PAGE || next === null) return all;
    cursor = next;
    // Progress on stderr: the results are what a reader pipes or greps, and a
    // carriage-returned counter sharing that stream swallows the line after it.
    if (all.length % 2000 === 0) {
      process.stderr.write(`\r  fetched ${all.length.toString()}…    `);
    }
  }
  // Fell out of the loop with pages still to come: the budget ran out, not the
  // window. Saying so is the difference between a number and a wrong number —
  // the first run of this script claimed seven days and had covered four hours.
  truncated = true;
  return all;
};

const quantile = (values: readonly number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
};

/** `latency` arrives in SECONDS — this only chooses how to show it. */
const secs = (seconds: number): string =>
  seconds >= 100 ? seconds.toFixed(0) : seconds.toFixed(1);
const pct = (part: number, whole: number): string =>
  whole === 0 ? "—" : `${((part / whole) * 100).toFixed(0)}%`;
const heading = (title: string): void => {
  console.info("");
  console.info(`── ${title} ${"─".repeat(Math.max(0, 62 - title.length))}`);
};

console.info("");
console.info(
  `Langfuse ${BASE} — environment "${environment}", last ${days.toString()} days`,
);
const observations = await fetchObservations();
if (observations.length === 0) {
  console.info("observations: 0 — nothing in that window.");
  process.exit(0);
}

// The window actually covered, not the one asked for. The API answers
// newest-first, so a budget that runs out truncates the OLD end — and a
// truncated window that still prints "last 7 days" is a wrong number wearing
// the clothes of a right one.
const startTimes = observations
  .map((o) => o.startTime)
  .filter((v): v is string => v !== null)
  .sort();
const oldest = startTimes[0];
console.info(
  `observations: ${observations.length.toString()}, covering ${oldest?.slice(0, 16) ?? "?"} → now`,
);
if (truncated) {
  console.info(
    `  TRUNCATED at --max ${MAX_OBSERVATIONS.toString()}: the window asked for ${days.toString()}d, the`,
  );
  console.info(
    `  numbers below cover only the range printed above. Raise --max or lower --days.`,
  );
}

// ---- The turns, grouped into runs -----------------------------------------
// A session is the run's conversation, so grouping turn observations by
// session gives whole runs without reading a single row of our own database.
const turns = observations.filter((o) => o.name === turnName);
heading(`"${turnName}" — turns and runs`);
if (turns.length === 0) {
  console.info(`  none in the window.`);
} else {
  const sessions = new Map<string, Observation[]>();
  for (const turn of turns) {
    const key = turn.sessionId ?? turn.traceId ?? turn.id;
    sessions.set(key, [...(sessions.get(key) ?? []), turn]);
  }
  const turnLatencies = turns
    .map((t) => t.latency)
    .filter((v): v is number => v !== null);
  const runClocks = [...sessions.values()].map((group) =>
    group.reduce((total, t) => total + (t.latency ?? 0), 0),
  );
  console.info(
    `  runs: ${sessions.size.toString()}, turns: ${turns.length.toString()} (${(turns.length / sessions.size).toFixed(1)}/run)`,
  );
  console.info(
    `  turn latency:  p50 ${secs(quantile(turnLatencies, 0.5))}s  p90 ${secs(quantile(turnLatencies, 0.9))}s  max ${secs(quantile(turnLatencies, 1))}s`,
  );
  console.info(
    `  run clock:     p50 ${secs(quantile(runClocks, 0.5))}s  p90 ${secs(quantile(runClocks, 0.9))}s  max ${secs(quantile(runClocks, 1))}s`,
  );
}

// ---- Where the clock goes, by operation -----------------------------------
// The table the plan's speed priority is decided on. A run that spends its
// clock in the sandbox is a different problem from one that spends it waiting
// on the model, and no count of tool calls tells them apart.
interface Bucket {
  count: number;
  total: number;
  latencies: number[];
  leafTotal: number;
}

/** Leaves only: a parent's seconds are its children's, counted once here. */
const parents = new Set(
  observations
    .map((o) => o.parentObservationId)
    .filter((v): v is string => v !== null),
);

const report = (title: string, rows: readonly Observation[]): void => {
  heading(title);
  if (rows.length === 0) {
    console.info("  nothing in the window.");
    return;
  }
  const buckets = new Map<string, Bucket>();
  let leafClock = 0;
  for (const o of rows) {
    const name = o.name ?? `(${o.type ?? "unnamed"})`;
    const bucket = buckets.get(name) ?? {
      count: 0,
      total: 0,
      latencies: [],
      leafTotal: 0,
    };
    bucket.count++;
    if (o.latency !== null) {
      bucket.total += o.latency;
      bucket.latencies.push(o.latency);
      if (!parents.has(o.id)) {
        bucket.leafTotal += o.latency;
        leafClock += o.latency;
      }
    }
    buckets.set(name, bucket);
  }
  // Who actually SPENT the seconds. Sorted by leaf time, because that is the
  // only column that adds up, and because sorting by total puts every parent
  // at the top of a table about where time goes — which is how a reader ends
  // up concluding that "the turn" is where the turn's time goes.
  console.info(
    `  ${"spent by".padEnd(30)} ${"count".padStart(6)} ${"seconds".padStart(9)}  share   (leaves only)`,
  );
  const leaves = [...buckets.entries()]
    .filter(([, b]) => b.leafTotal > 0)
    .sort(([, a], [, b]) => b.leafTotal - a.leafTotal)
    .slice(0, 10);
  for (const [name, bucket] of leaves) {
    console.info(
      `  ${name.slice(0, 30).padEnd(30)} ${bucket.count.toString().padStart(6)} ${`${secs(bucket.leafTotal)}s`.padStart(9)}  ${pct(bucket.leafTotal, leafClock).padStart(5)}`,
    );
  }
  console.info("");
  console.info(
    `  ${"operation (incl. nested)".padEnd(30)} ${"count".padStart(6)} ${"total".padStart(9)} ${"p50".padStart(8)} ${"p90".padStart(8)}`,
  );
  for (const [name, bucket] of [...buckets.entries()]
    .sort(([, a], [, b]) => b.total - a.total)
    .slice(0, 12)) {
    console.info(
      `  ${name.slice(0, 30).padEnd(30)} ${bucket.count.toString().padStart(6)} ${`${secs(bucket.total)}s`.padStart(9)} ${`${secs(quantile(bucket.latencies, 0.5))}s`.padStart(8)} ${`${secs(quantile(bucket.latencies, 0.9))}s`.padStart(8)}`,
    );
  }
};

// The workflow's own subtree first — it is the question the plan asks. Without
// this split the table is dominated by chat traffic, which outnumbers runs by
// more than ten to one, and every conclusion drawn from it would be about the
// chatbot wearing a workflow's name.
const turnTraceIds = new Set(
  turns.map((t) => t.traceId).filter((v): v is string => v !== null),
);
report(
  `Where a "${turnName}" run's clock goes`,
  observations.filter((o) => o.traceId !== null && turnTraceIds.has(o.traceId)),
);
report("Where the clock goes, everything in this environment", observations);

console.info("");
console.info(
  `  The three time columns OVERLAP — a turn contains the calls nested inside`,
);
console.info(
  `  it, so they cannot be added up. "leaf share" is the one that can: it`,
);
console.info(
  `  counts only observations that are nobody's parent, so each second is`,
);
console.info(`  attributed exactly once, to the thing that actually spent it.`);
console.info("");
