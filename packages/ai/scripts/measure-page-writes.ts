/**
 * What page writes actually cost, read back from `page_versions.meta`.
 *
 * The claim this whole chantier rests on — "a fix touching 7% of a page
 * re-emitted 100% of it" — was measured once, by hand, from two conversations.
 * This is the same measurement as a command, so the next argument about the
 * page builder is settled with a number instead of an anecdote.
 *
 *   bun run pages:measure-writes -- --hours 6
 *   bun run pages:measure-writes -- --hours 48 --team <teamId>
 *
 * Everything comes from the DATABASE. The `page-write` events are still
 * emitted and still useful in a trace, but a v4 `events_only` deployment
 * strips `metadata` from the observations API — the nineteen events of the
 * 2026-09-04 build came back carrying their names and nothing else — and
 * `GET /api/public/traces/:id`, which the cost half of this script used to
 * call, is gone from v4 entirely. It failed silently, so the cost line simply
 * never printed. The price now travels in `meta.usage`, counted by the process
 * that spent it (`src/lib/turn-usage.ts`).
 *
 * The arithmetic lives in `src/services/page-project/write-report.ts`, where
 * it is typechecked and tested: `scripts/*` is outside the tsconfig include,
 * and the two counting mistakes this report used to make both read as
 * measurements rather than as bugs.
 *
 * Read-only.
 */

import db from "@fretik/shared/db";
import { sql } from "drizzle-orm";
import type { PageWriteRecord } from "../src/services/page-project/store";
import {
  buildWriteReport,
  type PageVersionSample,
} from "../src/services/page-project/write-report";

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const readWrites = (value: unknown): PageWriteRecord[] => {
  if (typeof value !== "object" || value === null) return [];
  const writes = Reflect.get(value, "writes");
  if (!Array.isArray(writes)) return [];
  const rows: PageWriteRecord[] = [];
  for (const entry of writes) {
    if (typeof entry !== "object" || entry === null) continue;
    const mode = Reflect.get(entry, "mode");
    const path = Reflect.get(entry, "path");
    if ((mode !== "write" && mode !== "edit") || typeof path !== "string") {
      continue;
    }
    const callId = Reflect.get(entry, "callId");
    rows.push({
      mode,
      path,
      linesChanged: Number(Reflect.get(entry, "linesChanged") ?? 0),
      linesTotal: Number(Reflect.get(entry, "linesTotal") ?? 0),
      charsEmitted: Number(Reflect.get(entry, "charsEmitted") ?? 0),
      ratio: Number(Reflect.get(entry, "ratio") ?? 0),
      ...(typeof callId === "string" ? { callId } : {}),
    });
  }
  return rows;
};

const readUsage = (value: unknown): PageVersionSample["usage"] => {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = Reflect.get(value, "usage");
  if (typeof usage !== "object" || usage === null) return undefined;
  const costUsd = Reflect.get(usage, "costUsd");
  const steps = Reflect.get(usage, "steps");
  if (typeof costUsd !== "number" || typeof steps !== "number")
    return undefined;
  const costedSteps = Reflect.get(usage, "costedSteps");
  return {
    costUsd,
    steps,
    costedSteps: typeof costedSteps === "number" ? costedSteps : steps,
  };
};

const main = async (): Promise<void> => {
  const hours = Number(arg("hours") ?? "24");
  const team = arg("team");
  const since = new Date(Date.now() - hours * 3_600_000);

  const result = await db.execute<{
    page_id: string;
    created_at: Date;
    meta: unknown;
  }>(
    team === undefined
      ? sql`select page_id, created_at, meta from page_versions
            where created_at >= ${since} and meta ? 'writes'
            order by created_at`
      : sql`select page_id, created_at, meta from page_versions
            where created_at >= ${since} and team_id = ${team} and meta ? 'writes'
            order by created_at`,
  );

  const samples: PageVersionSample[] = result.rows.map((row) => {
    const usage = readUsage(row.meta);
    return {
      pageId: row.page_id,
      createdAt: new Date(row.created_at),
      writes: readWrites(row.meta),
      ...(usage !== undefined ? { usage } : {}),
    };
  });

  const report = buildWriteReport(samples);
  if (report.calls === 0) {
    console.log(
      `No measured page writes in the last ${hours.toString()}h. (Only builds since the 2026-09-04 change record them.)`,
    );
    return;
  }

  console.log(`\npage writes — last ${hours.toString()}h\n`);
  console.log(
    "  mode    calls   files   median chars/call   median ratio   p90 ratio   median lines changed",
  );
  for (const mode of report.byMode) {
    console.log(
      `  ${mode.mode.padEnd(8)}${mode.calls.toString().padEnd(8)}${mode.files.toString().padEnd(8)}${mode.medianCharsPerCall.toString().padEnd(20)}${mode.medianRatio.toFixed(2).padEnd(15)}${mode.p90Ratio.toFixed(2).padEnd(12)}${mode.medianLinesChanged.toString()}`,
    );
  }

  if (report.cost !== undefined) {
    console.log(
      `\n  cost per page: median $${report.cost.medianUsd.toFixed(2)}, p90 $${report.cost.p90Usd.toFixed(2)}, median ${report.cost.medianSteps.toString()} model steps, over ${report.cost.pages.toString()} priced page(s)`,
    );
  } else {
    console.log(
      "\n  no page carries a usage figure yet — only builds after the 2026-09-06 change record one.",
    );
  }

  console.log(
    `\n  ${report.calls.toString()} calls (${report.files.toString()} files) over ${report.pages.toString()} page(s) — ${report.callsPerPage.toFixed(1)} calls per page, ${(report.editShare * 100).toFixed(0)}% of them edits.`,
  );
  if (report.recordsWithoutCallId > 0) {
    console.log(
      `  ${report.recordsWithoutCallId.toString()} record(s) predate call ids and are counted as one call each — a batched write among them reads as several.`,
    );
  }
  if (report.truncatedPages > 0) {
    console.log(
      `  ${report.truncatedPages.toString()} page(s) hit the 80-record cap: their oldest writes were dropped, so these counts are a floor.`,
    );
  }

  // The one number the redesign is answerable to. The measured whole-file
  // rewrites ran 6-14; a fix that stays surgical sits near 1.
  const edits = report.byMode.find((mode) => mode.mode === "edit");
  if (edits !== undefined) {
    console.log(
      `  median rewrite ratio on fixes: ${edits.medianRatio.toFixed(2)} (target < 3; whole-file rewrites measured 6-14)\n`,
    );
  } else {
    console.log(
      "  no edits at all — every change was a whole-file write, which is the shape this was built to move away from.\n",
    );
  }
};

await main();
// Importing the project store opens a Redis client, and a live client keeps the
// event loop alive forever. The report is small enough to sit unflushed in a
// pipe's buffer, so a script that never exits is a script that prints nothing:
// this one looked like a hung query for half an hour on 2026-09-06 while its
// output waited behind an open socket. Read-only — there is nothing to drain.
process.exit(0);
