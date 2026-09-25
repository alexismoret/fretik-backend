import { and, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import db from "../../db";
import { decisionLog, type NewDecisionLogRow } from "../../db/schema";
import { isDecisionPointKey } from "../../decisions/keys";
import { decisionPoint } from "../../decisions/points";
import { chunkForBulk } from "../../lib/db-bulk";

/**
 * The decision journal: what was asked, what came of it, and — later — what
 * the right answer turned out to be. See `db/schema/decisions.ts` for why it
 * holds numbers and never text.
 *
 * Every write here is BEST-EFFORT. The journal exists to tune thresholds; a
 * decision that cannot be journaled must still be acted on, and a label that
 * cannot be written must not fail the move or the run that produced it.
 */

/**
 * One decision to journal. `label` may ride along only with source `legacy`:
 * what the path behind the point decided when it ran anyway — the
 * consolidation judge on a cluster the prescreen handed it — which labels
 * the point's verdict for free.
 */
export type JournalEntry = Omit<
  NewDecisionLogRow,
  "id" | "label" | "labelSource" | "labeledByUserId" | "labeledAt" | "createdAt"
> & { legacyLabel?: LabelValue };

/** Which of a point's decisions are kept, per its registry `journal`. */
const shouldJournal = (entry: JournalEntry): boolean => {
  if (!isDecisionPointKey(entry.point)) return false;
  const { policy, sampleRate } = decisionPoint(entry.point).journal;
  switch (policy) {
    case "all":
      return true;
    case "consequential":
      return entry.applied;
    case "sampled":
      return Math.random() < (sampleRate ?? 0);
    case "none":
      return false;
  }
};

/**
 * Journal a batch of decisions. Returns how many rows were written.
 *
 * A retried job re-journals the same questions; the unique index on
 * `(point, subject, question)` turns the second write into a no-op, so a
 * retry never counts twice in a calibration.
 */
export const recordDecisions = async (
  entries: readonly JournalEntry[],
): Promise<number> => {
  const now = new Date();
  const kept = entries.filter(shouldJournal).map(({ legacyLabel, ...entry }) =>
    legacyLabel === undefined
      ? entry
      : {
          ...entry,
          label: legacyLabel,
          labelSource: "legacy" satisfies LabelSource,
          labeledAt: now,
        },
  );
  if (kept.length === 0) return 0;
  try {
    let written = 0;
    for (const chunk of chunkForBulk(kept)) {
      // Sequential on purpose: chunks are rare (a gate asks about at most a
      // few dozen workflows) and one statement at a time keeps a failure's
      // blast radius to its own chunk.
      // eslint-disable-next-line no-await-in-loop
      const rows = await db
        .insert(decisionLog)
        .values(chunk)
        .onConflictDoNothing()
        .returning({ id: decisionLog.id });
      written += rows.length;
    }
    return written;
  } catch (error) {
    console.warn(
      "[decisions] could not journal decisions:",
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
};

/**
 * Where a label came from.
 *
 * Two kinds, and the difference decides who may overwrite whom. A person's
 * explicit act (`manual`, `filing_undone`, `run_anyway`) is the strongest
 * evidence there is and always replaces what was there. An inference from
 * what happened next (`run_outcome`, `document_moved`) only fills an empty
 * label: it is weaker evidence, and it must not undo what someone said.
 *
 * `legacy` is what the path behind the point decided when it ran, written
 * with the row. It is a reference, not the truth, and any later label
 * replaces it.
 */
export type LabelSource =
  | "run_anyway"
  | "run_outcome"
  | "document_moved"
  | "filing_undone"
  | "manual"
  | "legacy";

const EXPLICIT_SOURCES: ReadonlySet<LabelSource> = new Set([
  "run_anyway",
  "filing_undone",
  "manual",
]);

/** `true`/`false` for a boolean question, the right option for a choice. */
export type LabelValue = string;

const writeLabel = async (
  where: SQL | undefined,
  params: { label: LabelValue; source: LabelSource; userId?: string },
): Promise<string[]> => {
  try {
    const rows = await db
      .update(decisionLog)
      .set({
        label: params.label,
        labelSource: params.source,
        labeledByUserId: params.userId ?? null,
        labeledAt: new Date(),
      })
      .where(
        and(
          where,
          EXPLICIT_SOURCES.has(params.source)
            ? undefined
            : or(
                isNull(decisionLog.label),
                eq(decisionLog.labelSource, "legacy"),
              ),
        ),
      )
      .returning({ id: decisionLog.id });
    return rows.map((row) => row.id);
  } catch (error) {
    console.warn(
      "[decisions] could not label decisions:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
};

/**
 * Label the decisions a point made about one subject — optionally only the
 * one aimed at `targetId` (a gate asks one question per workflow about the
 * same event), or only the one journaled under `questionId` (a question
 * about something with no uuid of its own). Team-scoped: a label never
 * crosses a tenant. Returns the ids labelled.
 */
export const labelDecisions = async (params: {
  teamId: string;
  point: string;
  subjectId: string;
  targetId?: string;
  questionId?: string;
  label: LabelValue;
  source: LabelSource;
  userId?: string;
}): Promise<string[]> =>
  writeLabel(
    and(
      eq(decisionLog.teamId, params.teamId),
      eq(decisionLog.point, params.point),
      eq(decisionLog.subjectId, params.subjectId),
      params.targetId !== undefined
        ? eq(decisionLog.targetId, params.targetId)
        : undefined,
      params.questionId !== undefined
        ? eq(decisionLog.questionId, params.questionId)
        : undefined,
    ),
    params,
  );

/**
 * `labelDecisions` for many subjects that all get the SAME label, in one
 * statement per chunk: a person (or the agent) moving two hundred documents
 * into one folder answers two hundred filing decisions at once. Same
 * team scope and same overwrite rule as the single form. Returns the ids
 * labelled.
 */
export const labelDecisionsForSubjects = async (params: {
  teamId: string;
  point: string;
  subjectIds: readonly string[];
  label: LabelValue;
  source: LabelSource;
  userId?: string;
}): Promise<string[]> => {
  const labelled: string[] = [];
  for (const subjectIds of chunkForBulk([...params.subjectIds])) {
    // eslint-disable-next-line no-await-in-loop
    const ids = await writeLabel(
      and(
        eq(decisionLog.teamId, params.teamId),
        eq(decisionLog.point, params.point),
        inArray(decisionLog.subjectId, subjectIds),
      ),
      params,
    );
    labelled.push(...ids);
  }
  return labelled;
};

/**
 * The retention rule, applied by the nightly GC.
 *
 * An unlabelled row is worth keeping only while a label may still arrive —
 * runs finish in minutes, a misfiled document is noticed within days — so a
 * month is generous. A labelled row is calibration data and keeps a year.
 * Deleted in batches so one night with a large backlog never holds a long
 * lock on a table the gate writes to every 15 seconds.
 */
export const UNLABELED_RETENTION_DAYS = 30;
export const LABELED_RETENTION_DAYS = 365;
const PURGE_BATCH = 5_000;

const purgeWhere = async (where: SQL): Promise<number> => {
  let purged = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await db
      .select({ id: decisionLog.id })
      .from(decisionLog)
      .where(where)
      .limit(PURGE_BATCH);
    if (batch.length === 0) return purged;
    // eslint-disable-next-line no-await-in-loop
    const deleted = await db
      .delete(decisionLog)
      .where(
        inArray(
          decisionLog.id,
          batch.map((row) => row.id),
        ),
      )
      .returning({ id: decisionLog.id });
    purged += deleted.length;
    if (batch.length < PURGE_BATCH) return purged;
  }
};

export const purgeDecisionLog = async (
  now: Date = new Date(),
): Promise<{ unlabeled: number; labeled: number }> => {
  const day = 24 * 60 * 60 * 1000;
  const unlabeledBefore = new Date(
    now.getTime() - UNLABELED_RETENTION_DAYS * day,
  );
  const labeledBefore = new Date(now.getTime() - LABELED_RETENTION_DAYS * day);
  const unlabeled = await purgeWhere(
    and(
      isNull(decisionLog.label),
      lt(decisionLog.createdAt, unlabeledBefore),
    ) ?? sql`false`,
  );
  const labeled = await purgeWhere(
    and(
      sql`${decisionLog.label} IS NOT NULL`,
      lt(decisionLog.createdAt, labeledBefore),
    ) ?? sql`false`,
  );
  return { unlabeled, labeled };
};
