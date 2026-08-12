import { z } from "zod";
import {
  isTriggerableEventType,
  WORKFLOW_TRIGGERABLE_EVENT_TYPES,
} from "../services/domain-events/event-types";
import { reasoningLevelSchema } from "./reasoning";
import { WorkflowFormConfigSchema } from "./workflow-forms";

/**
 * Workflow schemas + shared constants — the SINGLE source of truth for
 * every workflow enum value and jsonb payload shape.
 *
 * Kept db-free on purpose (mirrors `schemas/skills-limits.ts`): both
 * `db/schema/workflows.ts` and every zod boundary import from here, so
 * changing a value updates the `pgEnum`, the jsonb column `$type`, and the
 * Zod validation together — never re-declared. The DB schema builds its
 * `pgEnum`s FROM the value tuples below (`pgEnum("workflow_status",
 * WORKFLOW_STATUS_VALUES)`), so the DB and the API share one source.
 *
 * This file also carries the Trigger.dev turn protocol
 * (`WorkflowTurnResultSchema`, `WorkflowRunTaskPayloadSchema`), so it must
 * stay importable by `@fretik/workflows` without pulling any Postgres /
 * Redis / Bun-env code into the Trigger bundle. Import NOTHING from `../db`
 * here.
 */

/** Trigger.dev task ids — shared by the task definitions and the
 * management-API callers (`lib/trigger-client.ts`). */
export const WORKFLOW_RUN_TASK_ID = "workflow-run";
export const WORKFLOW_CRON_TASK_ID = "workflow-cron";

// ==================== //
// ENUM VALUES (source) //
// ==================== //

export const WORKFLOW_STATUS_VALUES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export const WORKFLOW_AUTONOMY_VALUES = [
  "read_only",
  "approval_required",
  "autonomous",
] as const;
export const WORKFLOW_TRIGGER_TYPE_VALUES = [
  "manual",
  "cron",
  "event",
  "form",
] as const;
export const WORKFLOW_RUN_STATUS_VALUES = [
  "queued",
  "running",
  "needs_approval",
  "succeeded",
  "failed",
  "canceled",
] as const;
/**
 * Per-task lifecycle status. NOT a `pgEnum` — task states live inside the
 * `workflow_runs.task_states` jsonb, so this set is validated by Zod only.
 */
export const WORKFLOW_TASK_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "skipped",
  "failed",
] as const;

export const workflowStatusSchema = z.enum(WORKFLOW_STATUS_VALUES);
export const workflowAutonomySchema = z.enum(WORKFLOW_AUTONOMY_VALUES);
export const workflowTriggerTypeSchema = z.enum(WORKFLOW_TRIGGER_TYPE_VALUES);
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUS_VALUES);
export const workflowTaskStatusSchema = z.enum(WORKFLOW_TASK_STATUS_VALUES);

export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;
export type WorkflowAutonomy = z.infer<typeof workflowAutonomySchema>;
export type WorkflowTriggerType = z.infer<typeof workflowTriggerTypeSchema>;
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export type WorkflowTaskStatus = z.infer<typeof workflowTaskStatusSchema>;

// ==================== //
// PLAYBOOK (jsonb)     //
// ==================== //

/**
 * One playbook task — authored by the builder agent at creation time.
 * `key` is the stable identifier the executor agent uses for status
 * transitions; playbook edits that remove/rename a task mint a new key.
 */
export const WorkflowPlaybookTaskSchema = z.object({
  key: z
    .string()
    .regex(
      /^[a-z0-9_-]{1,40}$/,
      "task key must be 1-40 chars of a-z, 0-9, _ or -",
    ),
  title: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
  instructions: z.string().min(1).max(10000),
  expectedOutput: z.string().max(500).optional(),
  toolHints: z.array(z.string().max(60)).max(10).optional(),
});
export type WorkflowPlaybookTask = z.infer<typeof WorkflowPlaybookTaskSchema>;

/**
 * The structured playbook guiding one autonomous run, injected into the
 * workflow agent's system prompt (`{{playbookBlock}}`). The explicit plan
 * is the reliability lever — structured-plan guidance raises multi-step
 * tool-call accuracy far above a freeform goal.
 */
/**
 * The exact shape of what a run must produce, pinned at build time. A run
 * executes in a FRESH conversation and never sees the chat where the workflow
 * was created — so any output contract shown there (an example file, a column
 * list, a required format) must be captured HERE or the executor invents it.
 * Kept generic: `description` carries whatever fixes the deliverable — columns
 * and their order, separator, decimal format, file naming, a couple of example
 * rows, sections of a report, an email's subject line.
 */
export const WorkflowDeliverableSchema = z.object({
  format: z.string().min(1).max(60),
  description: z.string().min(1).max(2000),
});
export type WorkflowDeliverable = z.infer<typeof WorkflowDeliverableSchema>;

export const WorkflowPlaybookSchema = z
  .object({
    goal: z.string().min(1).max(1000),
    tasks: z.array(WorkflowPlaybookTaskSchema).min(1).max(20),
    successCriteria: z.string().max(1000).optional(),
    notes: z.string().max(1000).optional(),
    deliverable: WorkflowDeliverableSchema.optional(),
  })
  .superRefine((playbook, ctx) => {
    const seen = new Set<string>();
    for (const task of playbook.tasks) {
      if (seen.has(task.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate task key "${task.key}"`,
          path: ["tasks"],
        });
      }
      seen.add(task.key);
    }
  });
export type WorkflowPlaybook = z.infer<typeof WorkflowPlaybookSchema>;

// ==================== //
// TRIGGER CONFIG (jsonb)
// ==================== //

export const WorkflowCronConfigSchema = z.object({
  /** Standard 5-field cron pattern (minute hour day month weekday). */
  pattern: z
    .string()
    .regex(
      /^\S+ \S+ \S+ \S+ \S+$/,
      "cron pattern must have exactly 5 space-separated fields",
    ),
  /** IANA timezone, e.g. "Europe/Paris". Defaults to UTC when omitted. */
  timezone: z.string().max(64).optional(),
});

export const WorkflowEventConfigSchema = z.object({
  /** Journal event type to match, e.g. "document.uploaded". Restricted to the
   * triggerable workspace events (or a `connector.*` provider kind) so a typo
   * can't create a workflow that silently never fires. */
  type: z
    .string()
    .min(1)
    .max(120)
    .refine(isTriggerableEventType, {
      message: `event.type must be a triggerable workspace event (${WORKFLOW_TRIGGERABLE_EVENT_TYPES.join(", ")}) or a connector.<app>.<kind> event`,
    }),
  /**
   * Optional equality filter on the event payload — every entry must
   * match (`payload[key] === value`) for the workflow to fire.
   */
  filter: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

export const WorkflowTriggerConfigSchema = z.object({
  cron: WorkflowCronConfigSchema.optional(),
  event: WorkflowEventConfigSchema.optional(),
  form: WorkflowFormConfigSchema.optional(),
});
export type WorkflowTriggerConfig = z.infer<typeof WorkflowTriggerConfigSchema>;

/**
 * A trigger config sub-object must match the trigger type: a `cron` config under
 * an `event` type (or vice-versa) is dead config that signals a mistake, so it's
 * rejected at write. Empty config is consistent with any type (a draft may set a
 * type before filling it) — the stricter "cron requires a pattern" COMPLETENESS
 * check stays at activate time. Returns an error message, or null when
 * consistent. Cross-field, so it runs in the Create/Update `superRefine`.
 */
export const triggerConfigConsistencyError = (
  type: WorkflowTriggerType,
  config: WorkflowTriggerConfig,
): string | null => {
  if (config.cron && type !== "cron") {
    return `triggerConfig.cron is set but triggerType is "${type}" — clear it or switch triggerType to "cron".`;
  }
  if (config.event && type !== "event") {
    return `triggerConfig.event is set but triggerType is "${type}" — clear it or switch triggerType to "event".`;
  }
  if (config.form && type !== "form") {
    return `triggerConfig.form is set but triggerType is "${type}" — clear it or switch triggerType to "form".`;
  }
  return null;
};

// ==================== //
// LIMITS (jsonb)       //
// ==================== //

/**
 * User-visible run limits. A run is bounded by TIME (and optionally a
 * token budget) — never by a turn count: autonomy is the product.
 * `maxDurationMinutes` is capped at the platform ceiling (60 min, matching
 * the Trigger.dev task's `maxDuration: 3600`).
 */
export const WORKFLOW_MAX_DURATION_MINUTES = 60;
export const WorkflowLimitsSchema = z.object({
  maxDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_MAX_DURATION_MINUTES)
    .optional(),
  maxTotalTokens: z.number().int().min(1000).optional(),
});
export type WorkflowLimits = z.infer<typeof WorkflowLimitsSchema>;

// ==================== //
// NOTIFICATIONS (jsonb)//
// ==================== //

/**
 * Per-workflow completion-email rule. One switch covers every notable run
 * state (succeeded, failed, needs_approval park); canceled and test runs
 * never email. Effective recipients = `recipientUserIds` ∪ the run's
 * `triggeredByUserId` (when `notifyTriggeredBy`), re-intersected with the
 * team roster at send time — content never leaves the team.
 */
export const WorkflowNotificationsSchema = z.object({
  emailOnCompletion: z.boolean().default(false),
  /** Also email whoever started the run (manual run / logged-in form
   * submitter). Cron/event runs have no trigger actor. */
  notifyTriggeredBy: z.boolean().default(true),
  recipientUserIds: z.array(z.uuid()).max(50).default([]),
});
export type WorkflowNotifications = z.infer<typeof WorkflowNotificationsSchema>;

export const WORKFLOW_NOTIFICATIONS_DEFAULT: WorkflowNotifications = {
  emailOnCompletion: false,
  notifyTriggeredBy: true,
  recipientUserIds: [],
};

/**
 * Platform-wide fallback token budget when a workflow sets no explicit
 * `maxTotalTokens` — a coarse runaway backstop, not a product constraint (see
 * `WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS` usage in the turn handler for the
 * mid-turn abort). Env-overridable so ops can tune it without a code change.
 */
const parseWorkflowDefaultMaxTotalTokens = (): number => {
  const raw = process.env.WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS;
  if (raw === undefined || raw === "") return 6_000_000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error(
      `Invalid WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS: "${raw}" — expected an integer >= 1000.`,
    );
  }
  return parsed;
};
export const WORKFLOW_DEFAULT_MAX_TOTAL_TOKENS =
  parseWorkflowDefaultMaxTotalTokens();

/**
 * Platform ceilings applied whenever a workflow's own `limits` leaves a
 * field unset — surfaced on every `Workflow` response so the frontend can
 * show run progress against the REAL enforced ceiling instead of hiding
 * the bar when there's no explicit override.
 */
export const WorkflowDefaultLimitsSchema = z.object({
  maxTotalTokens: z.number().int(),
  maxDurationMinutes: z.number().int(),
});
export type WorkflowDefaultLimits = z.infer<typeof WorkflowDefaultLimitsSchema>;

// ==================== //
// RUN STATE (jsonb)    //
// ==================== //

/**
 * Per-task runtime state, snapshotted from the playbook at run creation —
 * INCLUDING the instructions, so editing a workflow never mutates an
 * in-flight or historical run and the turn handler / `completeTask` tool
 * read everything from the run row alone. The task cursor (= first
 * non-terminal task, in order) is derived from `status`, never stored:
 * the harness stamps `in_progress` at turn start and `completeTask`
 * advances it. Dates are ISO strings (jsonb).
 */
export const WorkflowTaskStateSchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string().default(""),
  instructions: z.string(),
  expectedOutput: z.string().optional(),
  toolHints: z.array(z.string()).optional(),
  status: workflowTaskStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  /** One-line outcome written by the agent on completion/failure/skip. */
  summary: z.string().max(500).optional(),
});
export type WorkflowTaskState = z.infer<typeof WorkflowTaskStateSchema>;

/** The task cursor: first in_progress task, else first pending, else null
 * (all tasks terminal). Pure — shared by the turn handler and the tool. */
export const currentWorkflowTask = (
  tasks: WorkflowTaskState[],
): WorkflowTaskState | null =>
  tasks.find((t) => t.status === "in_progress") ??
  tasks.find((t) => t.status === "pending") ??
  null;

export const WorkflowRunUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  /** Provider cache reads, a subset of `inputTokens`. Kept separate because a
   * multi-step run re-sends its whole context every step: the raw total reads
   * as runaway consumption when ~95% of it is cheap cache hits. Tokens only —
   * any cost/credit presentation happens in a display layer, never here. */
  cachedInputTokens: z.number().int().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(0),
});
export type WorkflowRunUsage = z.infer<typeof WorkflowRunUsageSchema>;

export const WorkflowRunOutputSchema = z.object({
  label: z.string().min(1).max(120),
  value: z.string().max(4000).optional(),
  /** Session file path when the output is a produced file (relative to the
   * run conversation's storage root, e.g. `outputs/report.xlsx`). The run page
   * builds its download URL from this + the run's conversationId. */
  filePath: z.string().max(500).optional(),
  /** File metadata (present for file outputs) — drives the run page's icon and
   * size label without a second lookup. */
  mimeType: z.string().max(150).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type WorkflowRunOutput = z.infer<typeof WorkflowRunOutputSchema>;

export const WorkflowRunErrorSchema = z.object({
  code: z.string().min(1).max(60),
  message: z.string().max(2000),
});
export type WorkflowRunError = z.infer<typeof WorkflowRunErrorSchema>;

// ==================== //
// TURN PROTOCOL        //
// (Trigger ⇆ AI svc)   //
// ==================== //

/**
 * Terminal payload of ONE agent turn — the contract between the AI
 * service's `/internal/trigger/runs/:runId/turn` endpoint and the
 * Trigger.dev orchestrator task. `continue` means the run needs more
 * turns; every other status is terminal for the run (needs_approval is
 * terminal for the TURN loop until the wait token completes). These are
 * protocol statuses, distinct from the `workflow_run_status` column.
 */
export const WorkflowTurnResultSchema = z.object({
  status: z.enum([
    "continue",
    "completed",
    "failed",
    "needs_approval",
    "canceled",
  ]),
  turnIndex: z.number().int().min(1),
  taskStates: z.array(WorkflowTaskStateSchema),
  usage: WorkflowRunUsageSchema,
  outputSummary: z.string().optional(),
  error: WorkflowRunErrorSchema.optional(),
  approvalRequestId: z.string().optional(),
});
export type WorkflowTurnResult = z.infer<typeof WorkflowTurnResultSchema>;

/** Payload of the `workflow-run` Trigger.dev task — ids only (the DB row is
 * the source of truth, re-read by the AI service every turn), plus the one
 * limit the orchestrator itself enforces: the wall-clock deadline. */
export const WorkflowRunTaskPayloadSchema = z.object({
  runId: z.uuid(),
  workflowId: z.uuid(),
  teamId: z.uuid(),
  /** Wall-clock budget (workflow.limits or the platform default) — the
   * orchestrator wraps up near it and fails the run at it. */
  maxDurationMinutes: z
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_MAX_DURATION_MINUTES)
    .default(WORKFLOW_MAX_DURATION_MINUTES),
});
export type WorkflowRunTaskPayload = z.infer<
  typeof WorkflowRunTaskPayloadSchema
>;

/** Body of POST /internal/trigger/runs/:runId/turn. */
export const WorkflowTurnRequestSchema = z.object({
  turnIndex: z.number().int().min(1),
  /** Set by the orchestrator near the wall-clock deadline — the turn
   * handler then injects a "wrap up and conclude now" instruction. */
  wrapUp: z.boolean().optional(),
});

/** Body of POST /internal/trigger/runs/:runId/wait-token. */
export const WorkflowWaitTokenRequestSchema = z.object({
  waitTokenId: z.string().min(1),
});

/** Body of POST /internal/trigger/runs/:runId/finalize. */
export const WorkflowFinalizeRequestSchema = z.object({
  status: z.enum(["failed", "canceled"]),
  error: WorkflowRunErrorSchema.optional(),
});

// ==================== //
// API (user-facing)    //
// ==================== //

export const CreateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).default(""),
    icon: z.string().max(60).optional(),
    color: z.string().max(20).optional(),
    triggerType: workflowTriggerTypeSchema.default("manual"),
    triggerConfig: WorkflowTriggerConfigSchema.default({}),
    playbook: WorkflowPlaybookSchema,
    autonomy: workflowAutonomySchema.default("approval_required"),
    modelProfileKey: z.string().max(64).optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    limits: WorkflowLimitsSchema.default({}),
    /** NULL/omitted = team-shared; set = private to that user. */
    userId: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    const err = triggerConfigConsistencyError(v.triggerType, v.triggerConfig);
    if (err) {
      ctx.addIssue({ code: "custom", message: err, path: ["triggerConfig"] });
    }
  });
export type CreateWorkflowInput = z.infer<typeof CreateWorkflowSchema>;

export const UpdateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
    icon: z.string().max(60).optional(),
    color: z.string().max(20).optional(),
    triggerType: workflowTriggerTypeSchema.optional(),
    triggerConfig: WorkflowTriggerConfigSchema.optional(),
    playbook: WorkflowPlaybookSchema.optional(),
    autonomy: workflowAutonomySchema.optional(),
    modelProfileKey: z.string().max(64).nullable().optional(),
    reasoningLevel: reasoningLevelSchema.nullable().optional(),
    limits: WorkflowLimitsSchema.optional(),
    notifications: WorkflowNotificationsSchema.optional(),
    /** Re-scope: NULL = team-shared, set = private to that user. The service
     * layer enforces it can only be `null` or the requester's own id — never
     * an arbitrary teammate (that would be impersonation). */
    userId: z.uuid().nullable().optional(),
  })
  .superRefine((v, ctx) => {
    // Only checkable when a patch carries BOTH the type and the config; a
    // type-only or config-only patch leaves the other side to the stored row.
    if (v.triggerType === undefined || v.triggerConfig === undefined) return;
    const err = triggerConfigConsistencyError(v.triggerType, v.triggerConfig);
    if (err) {
      ctx.addIssue({ code: "custom", message: err, path: ["triggerConfig"] });
    }
  });
export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowSchema>;

export const RunWorkflowRequestSchema = z.object({
  isTest: z.boolean().default(false),
  /** Trigger payload handed to the agent (manual/test runs). */
  payload: z.record(z.string(), z.unknown()).default({}),
});

const isoDate = z.union([z.string(), z.date()]);

export const WorkflowResponseSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  organizationId: z.uuid(),
  userId: z.uuid().nullable(),
  name: z.string(),
  description: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  status: workflowStatusSchema,
  triggerType: workflowTriggerTypeSchema,
  triggerConfig: WorkflowTriggerConfigSchema,
  playbook: WorkflowPlaybookSchema,
  autonomy: workflowAutonomySchema,
  modelProfileKey: z.string().nullable(),
  reasoningLevel: reasoningLevelSchema.nullable(),
  limits: WorkflowLimitsSchema,
  notifications: WorkflowNotificationsSchema,
  /** Platform ceilings used whenever `limits` doesn't set an explicit value
   * — the frontend shows run progress against these when the workflow has
   * no override, since that's what's actually enforced server-side. */
  defaultLimits: WorkflowDefaultLimitsSchema,
  /** Why a paused workflow stopped, when not a plain manual pause — e.g.
   * `circuit_breaker:<N>` after N consecutive failed runs. NULL otherwise. */
  pausedReason: z.string().nullable(),
  /** Opaque token keying the public form URL, present only for `form`
   * triggers. NULL for every other trigger type. */
  formToken: z.string().nullable(),
  /** Ready-to-share absolute URL to the form page (`<APP_URL>/f/<token>`),
   * derived from `formToken` server-side. NULL when there's no token. */
  formUrl: z.string().nullable(),
  createdByUserId: z.uuid().nullable(),
  lastRunAt: isoDate.nullable(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export const WorkflowRunResponseSchema = z.object({
  id: z.uuid(),
  workflowId: z.uuid(),
  status: workflowRunStatusSchema,
  triggerType: workflowTriggerTypeSchema,
  triggerPayload: z.record(z.string(), z.unknown()),
  conversationId: z.uuid().nullable(),
  /** Chat conversation that launched this run, when one did. The run's own
   * deliverables are mirrored back there under `runs/<runId>/`. */
  sourceConversationId: z.uuid().nullable(),
  triggerRunId: z.string().nullable(),
  taskStates: z.array(WorkflowTaskStateSchema),
  turnCount: z.number().int(),
  usage: WorkflowRunUsageSchema,
  outputSummary: z.string().nullable(),
  outputs: z.array(WorkflowRunOutputSchema).nullable(),
  error: WorkflowRunErrorSchema.nullable(),
  /** Pending approval id while `status === "needs_approval"` — lets the run
   * page render the same inline approve/reject card as the chat. */
  approvalRequestId: z.string().nullable(),
  isTest: z.boolean(),
  triggeredByUserId: z.uuid().nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  /** Cumulated time the run spent parked on a human (approvals), and the
   * start of the park currently open (NULL while it works). Subtract both
   * from `finishedAt - startedAt` to get worked time — what the run's budget
   * is actually enforced against. */
  pausedMs: z.number().int(),
  pausedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type WorkflowRunResponse = z.infer<typeof WorkflowRunResponseSchema>;

/**
 * Compact live-run descriptor for the workflow card list — one row per
 * NON-terminal run (queued/running/needs_approval), so a card can pulse the
 * workflow's current activity without loading full run history.
 */
export const WorkflowActiveRunSchema = z.object({
  runId: z.uuid(),
  workflowId: z.uuid(),
  status: workflowRunStatusSchema,
  isTest: z.boolean(),
  startedAt: isoDate.nullable(),
  createdAt: isoDate,
});
export type WorkflowActiveRun = z.infer<typeof WorkflowActiveRunSchema>;
