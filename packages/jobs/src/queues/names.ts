/**
 * Queue names + typed job payloads — the single source for every queue this
 * package owns. `document-processing` is NOT here: its queue/worker pair
 * stays factored in `@fretik/shared/services/documents/processing-queue`
 * (producers live in api/ai); this package only hosts its Worker.
 *
 * Job payloads stay thin (ids + routing fields): workers re-read fresh rows
 * from the DB, so a payload never goes stale in Redis.
 */

export const MEMORY_RESOLVE_QUEUE = "memory-resolve";
export const MEMORY_DISTILL_QUEUE = "memory-distill";
export const MEMORY_MAINTENANCE_QUEUE = "memory-maintenance";
export const RECORD_CARD_QUEUE = "record-card";
// Dedicated queue for the nightly per-team dreaming jobs (P6) — they hold
// dozens of sequential LLM calls each and must never block the 15s journal
// sweep on the maintenance queue. Concurrency is the scale knob.
export const MEMORY_DREAMING_QUEUE = "memory-dreaming";
// Dedicated queue for event-triggered workflow-run creation. The trigger
// sweep (on the maintenance queue) stays fast — it only reads events and
// enqueues here; the slow part (createWorkflowRun → Trigger.dev network call)
// runs on this queue so it never blocks the 15s journal/trigger sweeps.
export const WORKFLOW_TRIGGER_QUEUE = "workflow-trigger";
// Dedicated queue for the nightly MCP tool-snapshot drift refresh — each pass
// re-introspects every active MCP connection over the network (Nango proxy), so
// it must never share the 15s maintenance queue.
export const MCP_REFRESH_QUEUE = "mcp-refresh";
// Dedicated queue for the nightly collection-index sweep — one pass issues a
// `CREATE INDEX CONCURRENTLY` per missing index, each of which can run for
// minutes on a large table. On the concurrency-1 maintenance queue that is
// head-of-line blocking: the 15s journal and workflow-trigger sweeps would not
// run at all for the duration, once a night, right when a nightly import has
// just filled the journal.
export const COLLECTION_INDEX_QUEUE = "collection-index";

/** One journal event to resolve against the collection graph (P3). */
export interface MemoryResolveJobData {
  eventId: string;
  organizationId: string;
  teamId: string;
  type: string;
}

/** One conversation to (re-)distill into its episode (P4). */
export interface MemoryDistillJobData {
  conversationId: string;
  organizationId: string;
  teamId: string;
}

/** One record card to refresh in — or drop from — the recall index (P4). */
export interface RecordCardJobData {
  recordId: string;
  organizationId: string;
  teamId: string;
  op: "upsert" | "delete";
}

/** One team's nightly dreaming pass (P6) — jobId `dreaming-{teamId}-{date}`. */
export interface DreamingTeamJobData {
  teamId: string;
  organizationId: string;
}

/**
 * Eager consolidation of the cluster overlapping one just-distilled episode
 * (P8.3) — jobId `consolidate-{episodeId}`, on the dreaming queue so it never
 * blocks the 15s sweep. Catches cross-conversation contradictions within the
 * distill debounce instead of waiting for the nightly cron.
 */
export interface EagerConsolidateJobData {
  episodeId: string;
  teamId: string;
  organizationId: string;
}

/**
 * One event-triggered workflow run to create — jobId
 * `wfrun-{workflowId}-{eventId}` makes a re-swept event a BullMQ no-op. The
 * event is immutable (append-only journal), so carrying its payload here can
 * never go stale; the mutable workflow row is re-read in the worker.
 */
export interface WorkflowRunCreateJobData {
  workflowId: string;
  teamId: string;
  sourceEventId: string;
  triggerPayload: Record<string, unknown>;
}

/** Maintenance job names (scheduled on MEMORY_MAINTENANCE_QUEUE). */
export const JOURNAL_SWEEP_JOB = "journal-sweep";
/** 03:00 UTC cron — lists active teams and fans out DREAMING_TEAM_JOBs. */
export const DREAMING_SWEEP_JOB = "dreaming-sweep";
/** 04:00 UTC cron — demotes stale episodes out of the recall index. */
export const GC_DEMOTE_JOB = "gc-demote";
/** 15s — reads the journal and enqueues event-triggered workflow runs. */
export const WORKFLOW_TRIGGER_SWEEP_JOB = "workflow-trigger-sweep";
/** 5min — reclaims stalled (heartbeat-dead) workflow runs. */
export const WORKFLOW_STALL_SWEEP_JOB = "workflow-stall-sweep";
/** 5min — reconciles the conversation wait registry and re-signals owed
 * resumes (backstop for a completion or resume signal lost to a restart). */
export const CONVERSATION_TASK_SWEEP_JOB = "conversation-task-sweep";
/** 02:00 UTC cron — builds the field indexes big collection tables are missing and
 * retires the ones Postgres never reads. The catch-all trigger, for tables that
 * crossed the size threshold by growing row by row rather than through an
 * import or a page save. */
export const COLLECTION_INDEX_SWEEP_JOB = "collection-index-sweep";

/** Job name on MCP_REFRESH_QUEUE — 05:00 UTC cron, re-introspects every active
 * MCP connection and adopts any tool-surface change. */
export const MCP_SNAPSHOT_REFRESH_JOB = "mcp-snapshot-refresh";

/** Job names on MEMORY_DREAMING_QUEUE. */
export const DREAMING_TEAM_JOB = "dreaming-team";
export const EAGER_CONSOLIDATE_JOB = "eager-consolidate";

/** Job name on WORKFLOW_TRIGGER_QUEUE. */
export const WORKFLOW_RUN_CREATE_JOB = "workflow-run-create";
