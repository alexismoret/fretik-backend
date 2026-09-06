/**
 * Turn stored write records back into the two numbers anyone acts on: how a
 * page was written, and what it cost.
 *
 * Pure, and here rather than in `scripts/` because `scripts/*` sits outside
 * the tsconfig include and is therefore untypechecked and untestable — and
 * this arithmetic has already been wrong twice in ways that read as
 * measurements:
 *
 *   - **Records are not calls.** `measurePageWrite` runs inside `pageWrite`'s
 *     per-file loop, so one call carrying a twelve-file project layout leaves
 *     twelve records while one `pageEdit` leaves one. Counting records made
 *     writes look an order of magnitude more common than they are, and
 *     "3% of writes were edits" was reported from it in September 2026.
 *   - **Versions are cumulative.** `state.writes` is never reset, and every
 *     green build stamps the WHOLE array onto its version. Flattening every
 *     version of a page counts the first write once per build that followed
 *     it — weighted, by construction, toward the early whole-file layout and
 *     against the late edits.
 *
 * So: the last version per page, and grouped by call.
 */
import type { PageWriteRecord } from "./store";
import { MAX_TRACKED_WRITES } from "./store";

/** What a page's latest version knows about how it was written and priced. */
export interface PageVersionSample {
  pageId: string;
  createdAt: Date;
  writes: PageWriteRecord[];
  /** From `PageVersionMeta.usage` — absent on anything built before it existed. */
  usage?: {
    steps: number;
    costedSteps: number;
    costUsd: number;
  };
}

export interface ModeReport {
  mode: "write" | "edit";
  /** Tool calls. This is the number to compare against the other mode. */
  calls: number;
  /** Files touched. Above `calls` only for batched writes. */
  files: number;
  medianCharsPerCall: number;
  medianRatio: number;
  p90Ratio: number;
  medianLinesChanged: number;
}

export interface WriteReport {
  pages: number;
  calls: number;
  files: number;
  /** Share of CALLS that were edits, 0-1. The number the prose is aimed at. */
  editShare: number;
  callsPerPage: number;
  byMode: ModeReport[];
  /** Median / p90 across every page that reported a cost. */
  cost?: {
    pages: number;
    medianUsd: number;
    p90Usd: number;
    medianSteps: number;
  };
  /**
   * Pages whose record list hit `MAX_TRACKED_WRITES` — their oldest writes
   * were dropped before anything read them, so every count below is a floor.
   */
  truncatedPages: number;
  /**
   * Records with no `callId`, written before it existed. Each is counted as
   * its own call, which over-counts batched writes exactly the way the old
   * script did — named so a mixed window is not read as a clean one.
   */
  recordsWithoutCallId: number;
}

export const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[index] ?? 0;
};

/**
 * One version per page — the newest, which holds the complete cumulative list.
 *
 * Exported because it is the half that is easy to get wrong and easy to test:
 * take every version and the same write is counted once per build after it.
 */
export const latestPerPage = (
  samples: readonly PageVersionSample[],
): PageVersionSample[] => {
  const newest = new Map<string, PageVersionSample>();
  for (const sample of samples) {
    const seen = newest.get(sample.pageId);
    if (seen === undefined || sample.createdAt > seen.createdAt) {
      newest.set(sample.pageId, sample);
    }
  }
  return [...newest.values()];
};

/** One entry per tool call, with the files it carried. */
interface CallGroup {
  mode: "write" | "edit";
  files: PageWriteRecord[];
}

const groupIntoCalls = (
  pageId: string,
  writes: readonly PageWriteRecord[],
): CallGroup[] => {
  const calls: CallGroup[] = [];
  const byId = new Map<string, CallGroup>();
  for (const [index, write] of writes.entries()) {
    // A record with no call id is its own call. The page id and index keep two
    // such records apart rather than folding them into one phantom batch.
    const key = write.callId ?? `${pageId}:${index.toString()}`;
    const existing = byId.get(key);
    if (existing !== undefined) {
      existing.files.push(write);
      continue;
    }
    const group: CallGroup = { mode: write.mode, files: [write] };
    byId.set(key, group);
    calls.push(group);
  }
  return calls;
};

export const buildWriteReport = (
  samples: readonly PageVersionSample[],
): WriteReport => {
  const latest = latestPerPage(samples);
  const calls: CallGroup[] = [];
  let truncatedPages = 0;
  let recordsWithoutCallId = 0;
  const costs: number[] = [];
  const stepCounts: number[] = [];

  for (const page of latest) {
    if (page.writes.length >= MAX_TRACKED_WRITES) truncatedPages++;
    for (const write of page.writes) {
      if (write.callId === undefined) recordsWithoutCallId++;
    }
    calls.push(...groupIntoCalls(page.pageId, page.writes));
    if (page.usage !== undefined) {
      costs.push(page.usage.costUsd);
      stepCounts.push(page.usage.steps);
    }
  }

  const files = calls.reduce((total, call) => total + call.files.length, 0);
  const editCalls = calls.filter((call) => call.mode === "edit").length;

  const byMode: ModeReport[] = [];
  for (const mode of ["write", "edit"] as const) {
    const group = calls.filter((call) => call.mode === mode);
    if (group.length === 0) continue;
    const flat = group.flatMap((call) => call.files);
    // Per CALL, because that is what a step costs: a twelve-file layout is one
    // emission from the model's side.
    const charsPerCall = group.map((call) =>
      call.files.reduce((total, file) => total + file.charsEmitted, 0),
    );
    const ratios = flat.map((file) => file.ratio).filter((ratio) => ratio > 0);
    byMode.push({
      mode,
      calls: group.length,
      files: flat.length,
      medianCharsPerCall: percentile(charsPerCall, 50),
      medianRatio: percentile(ratios, 50),
      p90Ratio: percentile(ratios, 90),
      medianLinesChanged: percentile(
        flat.map((file) => file.linesChanged),
        50,
      ),
    });
  }

  return {
    pages: latest.length,
    calls: calls.length,
    files,
    editShare: calls.length === 0 ? 0 : editCalls / calls.length,
    callsPerPage: latest.length === 0 ? 0 : calls.length / latest.length,
    byMode,
    ...(costs.length > 0
      ? {
          cost: {
            pages: costs.length,
            medianUsd: percentile(costs, 50),
            p90Usd: percentile(costs, 90),
            medianSteps: percentile(stepCounts, 50),
          },
        }
      : {}),
    truncatedPages,
    recordsWithoutCallId,
  };
};
