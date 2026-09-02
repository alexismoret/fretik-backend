import {
  advanceWorkerCursor,
  ensureWorkerCursor,
  readEventsAfter,
} from "@fretik/shared/services/domain-events/consume";
import { filterWorkflowConversationIds } from "@fretik/shared/services/workflows/filter-workflow-conversation-ids";
import { listActiveEventWorkflows } from "@fretik/shared/services/workflows/list-active-event-workflows";
import { listExistingEventRuns } from "@fretik/shared/services/workflows/list-existing-event-runs";
import { intFromEnv } from "../lib/env";
import {
  buildTriggerJobs,
  pairWorkflowsWithEvents,
  selectTriggerCandidates,
} from "../lib/workflow-trigger-matching";
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

  // The conversation exclusion needs a query, so the candidate selection is
  // split in two: gather the conversations that belong to workflow runs, then
  // let the pure rule decide. Everything it filters on is in
  // `lib/workflow-trigger-matching.ts`, tested without a database.
  const convIds = [
    ...new Set(
      events
        .map((e) => e.conversationId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const workflowConvIds = await filterWorkflowConversationIds({
    conversationIds: convIds,
  });
  const candidates = selectTriggerCandidates(events, workflowConvIds);

  const teamIds = [...new Set(candidates.map((e) => e.teamId))];
  const workflows = await listActiveEventWorkflows({ teamIds });
  const pairs = pairWorkflowsWithEvents(candidates, workflows);

  let created = 0;
  if (pairs.length > 0) {
    const matchedWorkflowIds = [...new Set(pairs.map((p) => p.workflow.id))];
    // ONE query answers existence for every matched pair (replay dedup).
    const existing = await listExistingEventRuns({
      workflowIds: matchedWorkflowIds,
      sourceEventIds: [...new Set(pairs.map((p) => p.event.id))],
    });

    const jobs = buildTriggerJobs(pairs, existing);
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
