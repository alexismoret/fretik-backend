import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
// Single source of truth for enum values + jsonb payload shapes lives in
// the db-free `schemas/workflows.ts` (mirrors the `skills-limits.ts`
// pattern): the `pgEnum`s below are built FROM its value tuples and the
// jsonb columns are typed by its inferred types, so nothing is declared
// twice and drizzle-kit sees no schema-parse cycle (the reverse edge is
// type-only, erased at runtime).
import type {
  WorkflowLimits,
  WorkflowPlaybook,
  WorkflowRunError,
  WorkflowRunOutput,
  WorkflowRunUsage,
  WorkflowTaskState,
  WorkflowTriggerConfig,
} from "../../schemas/workflows";
import {
  WORKFLOW_AUTONOMY_VALUES,
  WORKFLOW_RUN_STATUS_VALUES,
  WORKFLOW_STATUS_VALUES,
  WORKFLOW_TRIGGER_TYPE_VALUES,
} from "../../schemas/workflows";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";

export const workflowStatusEnum = pgEnum("workflow_status", [
  ...WORKFLOW_STATUS_VALUES,
]);
export const workflowAutonomyEnum = pgEnum("workflow_autonomy", [
  ...WORKFLOW_AUTONOMY_VALUES,
]);
export const workflowTriggerTypeEnum = pgEnum("workflow_trigger_type", [
  ...WORKFLOW_TRIGGER_TYPE_VALUES,
]);
export const workflowRunStatusEnum = pgEnum("workflow_run_status", [
  ...WORKFLOW_RUN_STATUS_VALUES,
]);

/**
 * A workflow = an autonomous agent definition. It has the same
 * capabilities as the chatbot but runs headless (up to 1 h), guided by a
 * structured `playbook` the builder agent authors from the chat. Scoped by
 * the org→team→(optional user) triad: `userId` NULL = team-shared, set =
 * private to that user.
 */
export const workflows = pgTable(
  "workflows",
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
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),

    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    // Reuses the object_types icon/color convention (Lucide icon name +
    // semantic color token); the builder picks the icon via `searchIcons`.
    icon: varchar("icon", { length: 60 }),
    color: varchar("color", { length: 20 }),

    status: workflowStatusEnum("status").notNull().default("draft"),

    // Promoted to a column (not just inside triggerConfig) so the event
    // sweep can filter `WHERE trigger_type = 'event'` on an index.
    triggerType: workflowTriggerTypeEnum("trigger_type")
      .notNull()
      .default("manual"),
    triggerConfig: jsonb("trigger_config")
      .$type<WorkflowTriggerConfig>()
      .notNull()
      .default({}),

    playbook: jsonb("playbook").$type<WorkflowPlaybook>().notNull(),

    autonomy: workflowAutonomyEnum("autonomy")
      .notNull()
      .default("approval_required"),

    // Per-workflow model override; NULL → the `workflow` role default.
    modelProfileKey: varchar("model_profile_key", { length: 64 }),

    // User-visible run limits (wall-clock + optional token budget).
    limits: jsonb("limits").$type<WorkflowLimits>().notNull().default({}),

    // Trigger.dev schedule id (`sched_...`) while an active cron workflow
    // has a live schedule; NULL otherwise.
    triggerScheduleId: text("trigger_schedule_id"),

    // Why the workflow is paused, when it wasn't a plain manual pause — the
    // circuit breaker stamps `circuit_breaker:<N>` on auto-pause after N
    // consecutive failed runs. NULL for active/manually-paused workflows;
    // cleared on activate. Surfaced in the UI so the team knows it stopped.
    pausedReason: text("paused_reason"),

    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Denormalized for the card list ordering / "last run" chip.
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("workflows_team_status_idx").on(t.teamId, t.status),
    index("workflows_team_trigger_active_idx")
      .on(t.teamId, t.triggerType)
      .where(sql`status = 'active'`),
  ],
);

/**
 * One execution of a workflow. Our DB is the source of truth for the run
 * list + history (Trigger.dev data is not) — `triggerRunId` links to the
 * Trigger run for cancel, and `taskStates` mirrors the playbook progress
 * that drives the timeline UI.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Identity the agent acts as: workflow.userId or teamSettings.botUserId.
    actingUserId: uuid("acting_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Who fired a manual/test run (NULL for cron/event runs).
    triggeredByUserId: uuid("triggered_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    status: workflowRunStatusEnum("status").notNull().default("queued"),
    triggerType: workflowTriggerTypeEnum("trigger_type").notNull(),
    triggerPayload: jsonb("trigger_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    // Soft reference to the domain_events row that fired an event-triggered
    // run (no FK — same rationale as object_records.sourceEventId). The
    // partial unique index below dedups re-sweeps.
    sourceEventId: uuid("source_event_id"),

    // Owns the sandbox / files / memory audit for this run.
    conversationId: uuid("conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    // The CHAT conversation that launched this run (a builder `run_test`), if
    // any. On terminal close, the run posts a completion notice back here so
    // the user who triggered the test learns the outcome without leaving chat.
    // NULL for cron/event/manual-page runs.
    sourceConversationId: uuid("source_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    // Trigger.dev run id (`run_...`) for runs.cancel + realtime subscribe.
    triggerRunId: text("trigger_run_id"),
    // Current approval wait token id (set while status = needs_approval).
    waitTokenId: text("wait_token_id"),

    // Playbook snapshot + per-task {status, startedAt, finishedAt, summary}.
    taskStates: jsonb("task_states")
      .$type<WorkflowTaskState[]>()
      .notNull()
      .default([]),

    // Turn idempotency cursor (see the turn protocol): the AI handler
    // replays `lastTurnResult` when a retried turnIndex <= lastTurnIndex.
    lastTurnIndex: integer("last_turn_index").notNull().default(0),
    lastTurnResult: jsonb("last_turn_result").$type<Record<string, unknown>>(),
    turnCount: integer("turn_count").notNull().default(0),

    usage: jsonb("usage").$type<WorkflowRunUsage>().notNull().default({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
    }),
    outputSummary: text("output_summary"),
    outputs: jsonb("outputs").$type<WorkflowRunOutput[]>(),
    error: jsonb("error").$type<WorkflowRunError>(),

    isTest: boolean("is_test").notNull().default(false),
    // Updated every turn; the stall sweeper marks runs failed(STALLED)
    // after ~20 min without a heartbeat (unless awaiting approval).
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),

    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("workflow_runs_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("workflow_runs_team_status_idx").on(t.teamId, t.status),
    uniqueIndex("workflow_runs_source_event_uniq")
      .on(t.workflowId, t.sourceEventId)
      .where(sql`source_event_id IS NOT NULL`),
    // The stall sweeper scans running runs GLOBALLY (no team) every 5 min —
    // without this tiny partial index that's a seq scan of the whole run
    // history. Running rows are always few, so the index stays near-empty.
    index("workflow_runs_running_idx")
      .on(t.lastHeartbeatAt)
      .where(sql`status = 'running'`),
    // Run lookup by conversation — the memory distiller and the approval
    // resume path both resolve conversation → run.
    index("workflow_runs_conversation_idx").on(t.conversationId),
  ],
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;
export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
