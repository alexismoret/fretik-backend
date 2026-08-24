/**
 * create-vs-update cost, the way it has to be read on a Langfuse v4
 * events_only server:
 *  - usage is stamped once per CALL and repeated on each of its step spans,
 *    so consecutive spans sharing (in, out) collapse into one call;
 *  - only /api/public/v2/metrics aggregates, and high-cardinality dimensions
 *    need orderBy desc + config.row_limit;
 *  - the observation list paginates by `cursor`, not `page`.
 * Usage: bun run scripts/measure-page-write-cost.ts [hoursBack]
 */
import db from "@fretik/shared/db";
import { pageVersions } from "@fretik/shared/db/schema";
import { gte } from "drizzle-orm";

const host = "https://langfuse.fretik.com";
const auth = `Basic ${btoa(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`)}`;
const hours = Number(process.argv[2] ?? 3);
const from = new Date(Date.now() - hours * 3600_000);

const metrics = async (q: Record<string, unknown>) => {
  const r = await fetch(
    `${host}/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(q))}`,
    { headers: { Authorization: auth } },
  );
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 300)}`);
  return JSON.parse(t).data as Record<string, number | string>[];
};

const usage = await metrics({
  view: "observations",
  metrics: [
    { measure: "outputTokens", aggregation: "sum" },
    { measure: "inputTokens", aggregation: "sum" },
    { measure: "totalCost", aggregation: "sum" },
  ],
  dimensions: [{ field: "id" }],
  filters: [
    {
      column: "providedModelName",
      operator: "=",
      value: "google/gemini-3.7-flash",
      type: "string",
    },
  ],
  fromTimestamp: from.toISOString(),
  toTimestamp: new Date().toISOString(),
  orderBy: [{ field: "sum_outputTokens", direction: "desc" }],
  config: { row_limit: 1000 },
});
const byId = new Map(usage.map((u) => [String(u.id), u]));

const obs: { id: string; ts: string }[] = [];
let cursor: string | undefined;
for (let i = 0; i < 60; i += 1) {
  const url = new URL(`${host}/api/public/v2/observations`);
  url.searchParams.set("type", "GENERATION");
  url.searchParams.set("limit", "100");
  url.searchParams.set("fromStartTime", from.toISOString());
  if (cursor) url.searchParams.set("cursor", cursor);
  const r = await fetch(url, { headers: { Authorization: auth } });
  const j = (await r.json()) as {
    data: Record<string, unknown>[];
    meta?: { cursor?: string };
  };
  for (const o of j.data)
    obs.push({ id: String(o.id), ts: String(o.startTime) });
  if (!j.meta?.cursor || j.data.length === 0) break;
  cursor = j.meta.cursor;
}
obs.sort((a, b) => a.ts.localeCompare(b.ts));

const calls: { ts: number; out: number; inp: number; cost: number }[] = [];
for (const o of obs) {
  const u = byId.get(o.id);
  if (!u) continue;
  const out = Number(u.sum_outputTokens ?? 0);
  const inp = Number(u.sum_inputTokens ?? 0);
  const last = calls.at(-1);
  if (last && last.out === out && last.inp === inp) {
    last.cost += Number(u.sum_totalCost ?? 0);
    continue;
  }
  calls.push({
    ts: new Date(o.ts).getTime(),
    out,
    inp,
    cost: Number(u.sum_totalCost ?? 0),
  });
}

const writes = await db
  .select({
    operation: pageVersions.operation,
    createdAt: pageVersions.createdAt,
    name: pageVersions.name,
    definition: pageVersions.definition,
  })
  .from(pageVersions)
  .where(gte(pageVersions.createdAt, from))
  .orderBy(pageVersions.createdAt);
const real = writes.filter(
  (w) => w.operation === "create" || w.operation === "update",
);

const buckets = new Map<string, { n: number; out: number; cost: number }>();
for (const c of calls) {
  const next = real.find(
    (w) =>
      w.createdAt.getTime() >= c.ts && w.createdAt.getTime() - c.ts < 600_000,
  );
  const key = next ? next.operation : "no-write";
  const b = buckets.get(key) ?? { n: 0, out: 0, cost: 0 };
  b.n += 1;
  b.out += c.out;
  b.cost += c.cost;
  buckets.set(key, b);
}
console.log(`window=${hours}h  calls=${calls.length}  writes=${real.length}`);
for (const [k, v] of [...buckets].sort((a, b) => b[1].out - a[1].out)) {
  const writeCount = real.filter((w) => w.operation === k).length;
  const per = writeCount ? Math.round(v.out / writeCount) : 0;
  console.log(
    `  ${k.padEnd(10)} calls=${String(v.n).padStart(3)} out=${String(v.out).padStart(7)} $${v.cost.toFixed(3)}  writes=${String(writeCount).padStart(2)} → ${per} out-tokens per write`,
  );
}
process.exit(0);
