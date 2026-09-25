import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgTable,
  real,
  smallint,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Decision log — one row per question the decision model was asked, and what
 * came of it.
 *
 * It exists for ONE reason: a threshold is a measurement, and a measurement
 * needs data. Every bar in `decisions/points.ts` was set by argument; this is
 * where the evidence to move one accumulates, labelled for free by what
 * people and runs do afterwards ("run anyway", a run that ends
 * `not_applicable`, a document moved out of the folder it was filed in).
 *
 * NEVER TEXT. No state, no criterion, no question wording: only ids,
 * numbers and the short codes below. The content a decision was made about
 * belongs to the rows it describes, which have their own lifetimes and
 * deletions; a journal that copied it would be a second, unmanaged copy of
 * the workspace. `workflow_runs.gate_decision` keeps the readable snapshot a
 * person looks at; this keeps the numbers a threshold is tuned on.
 *
 * `label` is the TRUE ANSWER to the question, not a verdict on the model:
 * `true`/`false` for a boolean ("did the event really meet the condition?"),
 * the right option for a choice (a folder id, or `__root__`). Correctness is
 * derived from it at whatever threshold is being tried, which is what lets
 * one set of labels score every candidate bar.
 *
 * Purged by the nightly GC: unlabelled rows after 30 days, labelled ones
 * after a year.
 */
export const decisionLog = pgTable(
  "decision_log",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    /** Registry key (`workflow.gate`). Text, not an enum: a new point is a
     * code change, never a migration. */
    point: varchar("point", { length: 60 }).notNull(),
    /** The question-id prefix (`wf`), what thresholds are keyed by. */
    family: varchar("family", { length: 40 }).notNull(),
    questionId: varchar("question_id", { length: 120 }).notNull(),
    /** Two wordings never share a calibration. */
    questionVersion: smallint("question_version").notNull(),

    /** What was decided ABOUT: the event a gate judged, the document a filer
     * placed. Soft references, no FK — same rule as `domain_events`. */
    subjectType: varchar("subject_type", { length: 40 }).notNull(),
    subjectId: uuid("subject_id").notNull(),
    /** What the question or its answer points at: the workflow a gate asked
     * about, the folder a filer chose. Null when the answer is "none". */
    targetId: uuid("target_id"),

    /**
     * Point-specific, short: `allowed` / `filtered` / `fell_open` for the
     * gate, `filed` / `left` / `fell_open` for the filer.
     */
    outcome: varchar("outcome", { length: 20 }).notNull(),
    /** Whether the verdict CHANGED what happened. False on a fall-open, where
     * the path ran as if the point were absent — which is how it is told
     * apart from a real decision. */
    applied: boolean("applied").notNull(),
    /** Why, when there is a reason worth a code: the fall-open cause, or why a
     * document was left where it was. */
    reason: varchar("reason", { length: 40 }),

    /** P(true) on a boolean; the chosen option's probability on a choice. */
    probability: real("probability"),
    /** The distribution's certainty, on a choice or a score. Null when the
     * transport did not report one, which is never the same as zero. */
    confidence: real("confidence"),
    /** The option a choice picked, verbatim (`__root__` included). */
    choice: varchar("choice", { length: 120 }),
    /** A score answer's fractional position on its scale. */
    score: real("score"),
    /** The bar the verdict was read against, as echoed by the service. */
    threshold: real("threshold"),

    transport: varchar("transport", { length: 20 }),
    modelId: varchar("model_id", { length: 120 }),
    latencyMs: integer("latency_ms"),
    /** This question's SHARE of its call: one call answers many questions,
     * so the call's cost is divided evenly and a SUM stays exact. */
    costUsd: real("cost_usd"),

    /** The true answer. See the table comment. */
    label: varchar("label", { length: 120 }),
    /** `run_anyway`, `run_outcome`, `document_moved`, `filing_undone` or
     * `manual`. A person's explicit act replaces any label; an inference from
     * what happened next only fills an empty one (`services/decisions/journal.ts`). */
    labelSource: varchar("label_source", { length: 20 }),
    labeledByUserId: uuid("labeled_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    labeledAt: timestamp("labeled_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The team's recent decisions, per point: the dashboard and the admin
    // reads.
    index("decision_log_team_point_created_idx").on(
      table.teamId,
      table.point,
      table.createdAt.desc(),
    ),
    // One question about one subject is journaled once. A retried job writes
    // the same rows again, and the second write must be a no-op rather than
    // a duplicate that would count twice in every calibration.
    uniqueIndex("decision_log_subject_question_uq").on(
      table.point,
      table.subjectId,
      table.questionId,
    ),
    // The GC's two sweeps, each over only the rows it can delete.
    index("decision_log_unlabeled_created_idx")
      .on(table.createdAt)
      .where(sql`${table.label} IS NULL`),
    index("decision_log_labeled_point_idx")
      .on(table.point, table.createdAt)
      .where(sql`${table.label} IS NOT NULL`),
  ],
);

export type DecisionLogRow = typeof decisionLog.$inferSelect;
export type NewDecisionLogRow = typeof decisionLog.$inferInsert;
