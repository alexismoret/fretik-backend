import type { DomainEvent, Workflow } from "@fretik/shared/db/schema";
import { isImportOriginated } from "@fretik/shared/services/bulk-operations/agent-key";
import {
  advanceWorkerCursor,
  ensureWorkerCursor,
  readEventsAfter,
} from "@fretik/shared/services/domain-events/consume";
import { filterWorkflowConversationIds } from "@fretik/shared/services/workflows/filter-workflow-conversation-ids";
import { listActiveEventWorkflows } from "@fretik/shared/services/workflows/list-active-event-workflows";
import { listExistingEventRuns } from "@fretik/shared/services/workflows/list-existing-event-runs";
import { intFromEnv } from "../lib/env";
import { WORKFLOW_RUN_CREATE_JOB } from "../queues/names";
import { getWorkflowTriggerQueue } from "../queues/queues";

/**
 * The journal→workflow bridge — the event-trigger engine. Its own cursor
 * ("workflow-triggers") sweeps `domain_events` and, for every active
 * event-triggered workflow whose config matches an event, enqueues ONE run
 * creation on the dedicated `workflow-trigger` queue. The sweep itself is
 * fast (reads + BullMQ enqueue only); the slow `createWorkflowRun`
 * (Trigger.dev network call) runs off the queue.
 *
 * Same journal-as-outbox design as the memory sweep: a worker/Redis outage
 * never loses events (the cursor just resumes). Three guards keep it safe:
 *   - anti-loop: events a workflow itself emitted (`actorType 'workflow'` or
 *     `agentKey 'workflow:*'`) are skipped, so a run's own journal writes
 *     can never trigger another run.
 *   - bulk imports: events stamped `agentKey 'import:*'` are skipped too —
 *     entering history is not a stream of business events.
 *   - dedup: the partial unique index on `(workflow_id, source_event_id)` is
 *     the truth; the batched `listExistingEventRuns` set + the
 *     `wfrun-{wf}-{event}` jobId skip it earlier so a re-swept event never
 *     double-fires.
 *
 * Deliberately NO rate limit here: every matched event becomes a run row so a
 * bulk upload is never silently dropped — the Trigger.dev per-workflow queue
 * is the backpressure (runs wait as `queued`). The runaway guard
 * (`WORKFLOW_EVENT_RUNS_PER_HOUR`) lives in the create worker, which pauses
 * the workflow loudly instead of dropping events.
 */

const CURSOR_NAME = "workflow-triggers";

/** Shares the memory sweep's consistency-lag rationale (late-commit safety). */
const WATERMARK_MS = intFromEnv("MEMORY_SWEEP_WATERMARK_MS", 15_000);
const SWEEP_BATCH = intFromEnv("MEMORY_SWEEP_BATCH", 500);

/** A run's own journal writes must never trigger another run. */
const isWorkflowOriginated = (event: DomainEvent): boolean =>
  event.actorType === "workflow" ||
  (event.agentKey !== null && event.agentKey.startsWith("workflow:"));

/**
 * A bulk import's writes must not fire triggers either — same mechanism, same
 * `agentKey` convention, different reason: see `bulk-operations/agent-key.ts`.
 * A 200 000-row load is history being entered, not 200 000 things happening.
 */
const isImportedRecord = (event: DomainEvent): boolean =>
  isImportOriginated(event.agentKey);

/** Config match: event type equal + every filter entry equal on the payload. */
const matchesEvent = (workflow: Workflow, event: DomainEvent): boolean => {
  const config = workflow.triggerConfig.event;
  if (!config || config.type !== event.type) return false;
  if (!config.filter) return true;
  return Object.entries(config.filter).every(
    ([key, value]) => event.payload[key] === value,
  );
};

export const runWorkflowTriggerSweep = async (): Promise<{
  created: number;
}> => {
  const cursor = await ensureWorkerCursor(CURSOR_NAME);
  const events = await readEventsAfter({
    after: cursor,
    watermarkMs: WATERMARK_MS,
    limit: SWEEP_BATCH,
  });
  if (events.length === 0) return { created: 0 };

  const nonSelf = events.filter(
    (e) => !isWorkflowOriginated(e) && !isImportedRecord(e),
  );
  // A run's SDK/sub-agent writes journal under the run's OWN conversation —
  // `actorType`/`agentKey` miss those, so exclude any event whose conversation
  // is a workflow run's. This is what actually closes the self-trigger loop.
  const convIds = [
    ...new Set(
      nonSelf
        .map((e) => e.conversationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const workflowConvIds = await filterWorkflowConversationIds({
    conversationIds: convIds,
  });
  const candidates = nonSelf.filter(
    (e) => e.conversationId === null || !workflowConvIds.has(e.conversationId),
  );

  const teamIds = [...new Set(candidates.map((e) => e.teamId))];
  const workflows = await listActiveEventWorkflows({ teamIds });

  const byTeam = new Map<string, Workflow[]>();
  for (const workflow of workflows) {
    const list = byTeam.get(workflow.teamId) ?? [];
    list.push(workflow);
    byTeam.set(workflow.teamId, list);
  }

  // Match pairs IN MEMORY first — the expensive part of a sweep must be a
  // fixed handful of batch queries, never one round trip per (event ×
  // workflow) pair (500 events × 200 workflows would be 100k SELECTs and
  // starve the whole maintenance worker).
  const pairs: { workflow: Workflow; event: DomainEvent }[] = [];
  for (const event of candidates) {
    for (const workflow of byTeam.get(event.teamId) ?? []) {
      if (matchesEvent(workflow, event)) pairs.push({ workflow, event });
    }
  }

  let created = 0;
  if (pairs.length > 0) {
    const matchedWorkflowIds = [...new Set(pairs.map((p) => p.workflow.id))];
    // ONE query answers existence for every matched pair (replay dedup).
    const existing = await listExistingEventRuns({
      workflowIds: matchedWorkflowIds,
      sourceEventIds: [...new Set(pairs.map((p) => p.event.id))],
    });

    const jobs: Parameters<
      ReturnType<typeof getWorkflowTriggerQueue>["addBulk"]
    >[0] = [];
    for (const { workflow, event } of pairs) {
      if (existing.has(`${workflow.id}:${event.id}`)) continue;
      jobs.push({
        name: WORKFLOW_RUN_CREATE_JOB,
        data: {
          workflowId: workflow.id,
          teamId: workflow.teamId,
          sourceEventId: event.id,
          triggerPayload: event.payload,
        },
        opts: {
          jobId: `wfrun-${workflow.id}-${event.id}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      });
    }
    // No .catch: a Redis enqueue failure must throw so the sweep fails and
    // the cursor (advanced only at the end) stays put — the next sweep
    // replays the batch, and the jobId + the existence set dedup the rest.
    if (jobs.length > 0) {
      await getWorkflowTriggerQueue().addBulk(jobs);
      created = jobs.length;
    }
  }

  // Advance past the WHOLE batch — every event was evaluated; the ones we
  // skipped (workflow-originated, unmatched) are permanently skipped. Every
  // matched, non-duplicate event has a BullMQ job by now, so advancing is
  // lossless for them.
  const last = events[events.length - 1];
  if (last) {
    await advanceWorkerCursor({ name: CURSOR_NAME, position: last.id });
  }

  return { created };
};
