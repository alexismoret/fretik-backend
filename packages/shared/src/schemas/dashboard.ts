import { z } from "zod";

/**
 * Wire schemas for the home dashboard aggregates — the summary (workspace
 * KPIs + this-week documents), the unified recent-activity feed, and the
 * needs-attention inbox. Each endpoint returns ONE round-trip payload so a
 * dashboard card renders without fanning out per-entity queries.
 */

// ---------------------------------------------------------------------------
// GET /dashboard/summary
// ---------------------------------------------------------------------------

const trendSchema = z
  .number()
  .nullable()
  .describe("Week-over-week percentage change, or null when no prior data");

export const dashboardSummaryResponseSchema = z.object({
  /** Total confirmed records across the team's objects + weekly trend. */
  records: z.object({ total: z.number(), trendPct: trendSchema }),
  /** Records created per day over the last 14 days (oldest → newest). */
  recordsSpark: z.array(z.number()),
  /** Workflow runs in the last 7 days + share that succeeded (0–100). */
  runs7d: z.object({
    total: z.number(),
    successRate: z.number().nullable(),
  }),
  /** Documents processed this week, one bucket per day (oldest → newest). */
  documentsThisWeek: z.object({
    series: z.array(z.object({ day: z.string(), count: z.number() })),
    total: z.number(),
    trendPct: trendSchema,
  }),
});

export type DashboardSummaryResponse = z.infer<
  typeof dashboardSummaryResponseSchema
>;

// ---------------------------------------------------------------------------
// GET /dashboard/activity
// ---------------------------------------------------------------------------

export const dashboardActivityItemSchema = z.object({
  id: z.uuid(),
  /** Raw `domain_events.type` (e.g. "record.confirmed", "document.uploaded",
   *  "workflow.run.completed") — the frontend maps it to icon/verb/route. */
  type: z.string(),
  /** Best label: subject record, workflow name, or a payload-derived name.
   *  May be empty (frontend falls back to the verb). */
  title: z.string(),
  /** Who acted (user display name), or null for system/agent/workflow. */
  actorName: z.string().nullable(),
  /** Run outcome for `workflow.run.completed` (succeeded/failed/canceled). */
  status: z.string().nullable(),
  // Routing hints — the frontend builds the href from these + `type`.
  documentId: z.string().nullable(),
  objectTypeKey: z.string().nullable(),
  workflowId: z.string().nullable(),
  runId: z.string().nullable(),
  at: z.date(),
});

export const dashboardActivityResponseSchema = z.object({
  items: z.array(dashboardActivityItemSchema),
});

export type DashboardActivityItem = z.infer<typeof dashboardActivityItemSchema>;
export type DashboardActivityResponse = z.infer<
  typeof dashboardActivityResponseSchema
>;

// ---------------------------------------------------------------------------
// GET /dashboard/attention
// ---------------------------------------------------------------------------

export const dashboardAttentionItemSchema = z.object({
  /** Run id — the frontend links to /workflows/{workflowId}?run={id}. */
  id: z.uuid(),
  workflowId: z.uuid(),
  kind: z.enum(["approval", "error"]),
  title: z.string(),
  /** When the run started needing attention — paused for approval, or failed. */
  at: z.date(),
});

export const dashboardAttentionResponseSchema = z.object({
  count: z.number(),
  items: z.array(dashboardAttentionItemSchema),
});

export type DashboardAttentionItem = z.infer<
  typeof dashboardAttentionItemSchema
>;
export type DashboardAttentionResponse = z.infer<
  typeof dashboardAttentionResponseSchema
>;
