/**
 * What page writes actually cost, read back from `page_versions.meta.writes`.
 *
 * The claim this whole chantier rests on — "a fix touching 7% of a page
 * re-emitted 100% of it" — was measured once, by hand, from two conversations.
 * This is the same measurement as a command, so the next argument about the
 * page builder is settled with a number instead of an anecdote.
 *
 *   bun run pages:measure-writes -- --hours 6
 *   bun run pages:measure-writes -- --hours 48 --team <teamId>
 *
 * The write ratios come from the DATABASE, not from Langfuse. The `page-write`
 * events are still emitted and still useful in a trace, but a v4 `events_only`
 * deployment strips `metadata` from the observations API: the nineteen events
 * of the 2026-09-04 build came back carrying their names and nothing else, and
 * the first version of this script measured `undefined` for every field it
 * asked for. A number kept in our own row cannot be dropped by someone else's
 * ingestion mode.
 *
 * The COST is the one thing that has to come from Langfuse, because that is
 * where tokens are priced. Each version carries the turn that wrote it, so the
 * lookup is a key rather than a search — and it is skipped in silence without
 * credentials, since the ratios above are what this script is for.
 *
 * Read-only, and outside the tsconfig include like every other script here.
 */

import db from "@fretik/shared/db";
import { sql } from "drizzle-orm";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

interface WriteRow {
  mode: string;
  path: string;
  linesChanged: number;
  linesTotal: number;
  charsEmitted: number;
  ratio: number;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
};

const readWrites = (value: unknown): WriteRow[] => {
  if (typeof value !== "object" || value === null) return [];
  const writes = Reflect.get(value, "writes");
  if (!Array.isArray(writes)) return [];
  const rows: WriteRow[] = [];
  for (const entry of writes) {
    if (typeof entry !== "object" || entry === null) continue;
    const mode = Reflect.get(entry, "mode");
    const path = Reflect.get(entry, "path");
    if (typeof mode !== "string" || typeof path !== "string") continue;
    rows.push({
      mode,
      path,
      linesChanged: Number(Reflect.get(entry, "linesChanged") ?? 0),
      linesTotal: Number(Reflect.get(entry, "linesTotal") ?? 0),
      charsEmitted: Number(Reflect.get(entry, "charsEmitted") ?? 0),
      ratio: Number(Reflect.get(entry, "ratio") ?? 0),
    });
  }
  return rows;
};

/**
 * What each of those pages cost to think about, from Langfuse.
 *
 * Characters emitted are half the bill and the cheaper half: the builder
 * replays a cached prefix once per step, so a page's cost is dominated by how
 * many times it went round, not by how much it wrote. That number lives with
 * whoever prices the tokens, and the version row carries the key to ask.
 *
 * Silent when the credentials are absent — the write ratios above are the
 * point of this script and they need no network. A trace Langfuse has not
 * finished ingesting simply does not answer yet.
 */
const reportCost = async (
  versions: { page_id: string; meta: unknown }[],
): Promise<void> => {
  const host = Bun.env.LANGFUSE_BASEURL ?? Bun.env.LANGFUSE_HOST ?? "";
  const publicKey = Bun.env.LANGFUSE_PUBLIC_KEY ?? "";
  const secretKey = Bun.env.LANGFUSE_SECRET_KEY ?? "";
  if (host === "" || publicKey === "" || secretKey === "") return;

  // One trace per PAGE, the most recent: a build coalesces into one version,
  // and pricing every round would count the same turn several times.
  const traceByPage = new Map<string, string>();
  for (const row of versions) {
    const meta =
      typeof row.meta === "object" && row.meta !== null ? row.meta : {};
    const traceId = Reflect.get(meta, "traceId");
    if (typeof traceId === "string" && traceId.length > 0) {
      traceByPage.set(row.page_id, traceId);
    }
  }
  if (traceByPage.size === 0) return;

  const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
  const costs: number[] = [];
  for (const traceId of traceByPage.values()) {
    const response = await fetch(
      `${host.replace(/\/$/, "")}/api/public/traces/${traceId}`,
      { headers: { authorization: auth } },
    ).catch(() => null);
    if (!response?.ok) continue;
    const body: unknown = await response.json().catch(() => null);
    const total =
      typeof body === "object" && body !== null
        ? Reflect.get(body, "totalCost")
        : undefined;
    if (typeof total === "number" && total > 0) costs.push(total);
  }
  if (costs.length === 0) {
    console.log(
      `\n  ${traceByPage.size.toString()} page(s) carry a trace, none priced yet — Langfuse ingests a turn a few minutes after it ends.`,
    );
    return;
  }
  const median = percentile(costs, 50);
  console.log(
    `\n  cost per page: median $${median.toFixed(2)}, p90 $${percentile(costs, 90).toFixed(2)}, over ${costs.length.toString()} priced turn(s)`,
  );
};

const main = async (): Promise<void> => {
  const hours = Number(arg("hours") ?? "24");
  const team = arg("team");
  const since = new Date(Date.now() - hours * 3_600_000);

  const result = await db.execute<{
    id: string;
    page_id: string;
    created_at: Date;
    meta: unknown;
  }>(
    team === undefined
      ? sql`select id, page_id, created_at, meta from page_versions
            where created_at >= ${since} and meta ? 'writes'
            order by created_at`
      : sql`select id, page_id, created_at, meta from page_versions
            where created_at >= ${since} and team_id = ${team} and meta ? 'writes'
            order by created_at`,
  );

  const versions = result.rows;
  const writes = versions.flatMap((row) => readWrites(row.meta));
  if (writes.length === 0) {
    console.log(
      `No measured page writes in the last ${hours.toString()}h. (Only builds since the 2026-09-04 change record them.)`,
    );
    return;
  }

  console.log(`\npage writes — last ${hours.toString()}h\n`);
  console.log(
    "  mode    calls   median chars   median ratio   p90 ratio   median lines changed",
  );
  for (const mode of ["write", "edit"] as const) {
    const group = writes.filter((write) => write.mode === mode);
    if (group.length === 0) continue;
    const chars = group.map((write) => write.charsEmitted);
    const ratios = group
      .map((write) => write.ratio)
      .filter((ratio) => ratio > 0);
    const changed = group.map((write) => write.linesChanged);
    console.log(
      `  ${mode.padEnd(8)}${group.length.toString().padEnd(8)}${percentile(chars, 50).toString().padEnd(15)}${percentile(ratios, 50).toFixed(2).padEnd(15)}${percentile(ratios, 90).toFixed(2).padEnd(12)}${percentile(changed, 50).toString()}`,
    );
  }

  await reportCost(versions);

  const pages = new Set(versions.map((row) => row.page_id));
  const edits = writes.filter((write) => write.mode === "edit").length;
  console.log(
    `\n  ${writes.length.toString()} writes over ${pages.size.toString()} page(s) in ${versions.length.toString()} version(s) — ${(writes.length / Math.max(pages.size, 1)).toFixed(1)} per page, ${((edits / writes.length) * 100).toFixed(0)}% of them edits.`,
  );

  // The one number the redesign is answerable to. The measured whole-file
  // rewrites ran 6-14; a fix that stays surgical sits near 1.
  const fixRatios = writes
    .filter((write) => write.mode === "edit")
    .map((write) => write.ratio)
    .filter((ratio) => ratio > 0);
  if (fixRatios.length > 0) {
    console.log(
      `  median rewrite ratio on fixes: ${percentile(fixRatios, 50).toFixed(2)} (target < 3; whole-file rewrites measured 6-14)\n`,
    );
  } else {
    console.log(
      "  no edits at all — every change was a whole-file write, which is the shape this was built to move away from.\n",
    );
  }
};

await main();
