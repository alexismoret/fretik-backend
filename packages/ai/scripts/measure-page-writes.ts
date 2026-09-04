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
 * It reads the DATABASE, not Langfuse. The `page-write` events are still
 * emitted and still useful in a trace, but a v4 `events_only` deployment strips
 * `metadata` from the observations API: the nineteen events of the 2026-09-04
 * build came back carrying their names and nothing else, and the first version
 * of this script measured `undefined` for every field it asked for. Read-only,
 * and outside the tsconfig include like every other script here.
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
