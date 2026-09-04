import { diffLines } from "@fretik/shared/lib/line-diff";
import { getActiveSpanId, startObservation } from "@langfuse/tracing";
import { MAX_TRACKED_WRITES, type PageWriteRecord } from "./store";

/**
 * What every write to a page's project cost, as a number.
 *
 * The whole chantier rests on one measurement — a fix touching 7% of a page
 * re-emitted 100% of it, three times over — and that measurement was made by
 * hand, from two conversations, after the fact. If the ratio is going to be the
 * thing this design is judged on, it has to be a column, not an archaeology
 * exercise: `scripts/measure-page-writes.ts` reads these events back.
 *
 * `rewriteRatio` is the number that matters: characters EMITTED per line
 * actually changed, divided by what those lines weigh. 1 is a perfect edit; the
 * measured whole-file rewrites ran 6-14.
 */

export type PageWriteMode = "write" | "edit" | "build";

export interface PageWriteStat {
  mode: PageWriteMode;
  path: string;
  /** Lines that differ between before and after. */
  linesChanged: number;
  /** Lines the file holds afterwards. */
  linesTotal: number;
  /** Characters the model had to produce for this call. */
  charsEmitted: number;
  /** Findings this call introduced, by rule. */
  lintDelta?: string[];
}

/** Emitted / what the change itself weighs. 1 is surgical; 10 is a rewrite. */
export const rewriteRatio = (stat: {
  charsEmitted: number;
  linesChanged: number;
  linesTotal: number;
  charsTotal: number;
}): number => {
  if (stat.linesChanged === 0 || stat.linesTotal === 0) return 0;
  const changedWeight =
    (stat.charsTotal / stat.linesTotal) * stat.linesChanged || 1;
  return Math.round((stat.charsEmitted / changedWeight) * 100) / 100;
};

/**
 * Measure one call and file its event. One entry point, so a new write path
 * cannot forget half of it.
 */
export const measurePageWrite = (params: {
  mode: PageWriteMode;
  path: string;
  before: string | undefined;
  after: string;
  /** What the model actually sent — a whole file, or just the new text. */
  charsEmitted: number;
  lintDelta?: string[];
}): PageWriteRecord => {
  const diff = diffLines(params.before ?? "", params.after);
  const linesTotal = params.after === "" ? 0 : params.after.split("\n").length;
  const ratio = rewriteRatio({
    charsEmitted: params.charsEmitted,
    linesChanged: diff.changed,
    linesTotal,
    charsTotal: params.after.length,
  });
  recordPageWrite({
    mode: params.mode,
    path: params.path,
    linesChanged: diff.changed,
    linesTotal,
    charsEmitted: params.charsEmitted,
    ...(params.lintDelta !== undefined ? { lintDelta: params.lintDelta } : {}),
    ratio,
  });
  // Returned as well as traced: the event may not survive the deployment it
  // lands on (v4 `events_only` strips metadata), the working copy always does.
  return {
    mode: params.mode === "build" ? "write" : params.mode,
    path: params.path,
    linesChanged: diff.changed,
    linesTotal,
    charsEmitted: params.charsEmitted,
    ratio,
  };
};

/** Append one measurement, oldest dropped first. */
export const trackWrite = (
  writes: PageWriteRecord[] | undefined,
  record: PageWriteRecord,
): PageWriteRecord[] => [...(writes ?? []), record].slice(-MAX_TRACKED_WRITES);

/**
 * One `page-write` event per call, on the run's own trace.
 *
 * An event rather than a database column: this is telemetry about HOW a page
 * was written, not part of the page. It is also fire-and-forget by
 * construction — a broken tracer must never be the reason a write fails, which
 * is why every path here swallows.
 */
export const recordPageWrite = (
  stat: PageWriteStat & { ratio: number },
): void => {
  // No active span means no trace to hang it on: an observation opened here
  // would be an orphan root, one per keystroke of the build.
  if (getActiveSpanId() === undefined) return;
  try {
    startObservation(
      `page-write ${stat.mode}`,
      {
        input: { path: stat.path },
        metadata: {
          mode: stat.mode,
          path: stat.path,
          linesChanged: stat.linesChanged,
          linesTotal: stat.linesTotal,
          charsEmitted: stat.charsEmitted,
          rewriteRatio: stat.ratio,
          ...(stat.lintDelta !== undefined && stat.lintDelta.length > 0
            ? { lintDelta: stat.lintDelta }
            : {}),
        },
      },
      { asType: "event" },
    ).end();
  } catch {
    // Swallow: telemetry never breaks a build.
  }
};
