import type { DomainEvent, Workflow } from "@fretik/shared/db/schema";
import { matchesEvent } from "@fretik/shared/services/workflows/trigger-matching";

import { WORKFLOW_GATE_JOB } from "../queues/names";
import type { getWorkflowGateQueue } from "../queues/queues";

// The predicates live in shared, where the criterion backtest reads the same
// ones; re-exported so the sweep and its tests keep one import site.
export {
  isConnectorRecord,
  isImportedRecord,
  isWorkflowOriginated,
  matchesEvent,
  selectTriggerCandidates,
} from "@fretik/shared/services/workflows/trigger-matching";

/**
 * The decisions the event-trigger sweep makes, separated from the queries and
 * the enqueue it makes them with.
 *
 * They live apart because they are the whole correctness of the bridge and
 * none of them needs a database: whether an event is a workflow's own output
 * (the anti-loop guard — get this wrong and a workflow triggers itself
 * forever), whether it is a bulk import replaying history, whether a trigger
 * config matches, and what the dedup key of the resulting job is. The sweep
 * itself is then a cursor read, three batch queries and an `addBulk`.
 */

/**
 * Every (workflow, event) pair that should produce a run, matched IN MEMORY.
 *
 * The expensive part of a sweep must stay a fixed handful of batch queries,
 * never one round trip per pair: 500 events × 200 workflows is 100 000 SELECTs
 * and starves the whole maintenance worker. A workflow only ever sees events
 * from its own team.
 */
export const pairWorkflowsWithEvents = (
  events: readonly DomainEvent[],
  workflows: readonly Workflow[],
): { workflow: Workflow; event: DomainEvent }[] => {
  const byTeam = new Map<string, Workflow[]>();
  for (const workflow of workflows) {
    const list = byTeam.get(workflow.teamId) ?? [];
    list.push(workflow);
    byTeam.set(workflow.teamId, list);
  }

  const pairs: { workflow: Workflow; event: DomainEvent }[] = [];
  for (const event of events) {
    for (const workflow of byTeam.get(event.teamId) ?? []) {
      if (matchesEvent(workflow, event)) pairs.push({ workflow, event });
    }
  }
  return pairs;
};

/** The dedup identity of a run: one per (workflow, source event), forever. */
export const triggerRunKey = (workflowId: string, eventId: string): string =>
  `${workflowId}:${eventId}`;

type GateJobs = Parameters<
  ReturnType<typeof getWorkflowGateQueue>["addBulk"]
>[0];

/**
 * The gate jobs to enqueue for a set of pairs, minus the ones that already
 * have a run — ONE per EVENT, carrying every workflow it matched.
 *
 * Batching by event rather than by pair is what makes the gate affordable.
 * The fact sheet is the expensive half of a decision (output tokens are free
 * on that endpoint), so resolving it once and asking N questions about it
 * turns twenty listening workflows into one request instead of twenty.
 *
 * Three things dedup a re-swept event, and they must agree on one identity:
 * the partial unique index on `(workflow_id, source_event_id)` in Postgres,
 * the `existing` set read in one query before this call, and the BullMQ
 * `jobId`. The jobId is now the EVENT's — `wfgate-{eventId}` — while the run
 * identity stays per pair, which is why the pair-level `existing` filter runs
 * HERE and the resulting job carries only the workflows that survived it. A
 * replayed batch therefore re-asks nothing: the job id collides, and even if
 * retention lapsed the create worker re-checks each pair before spending a
 * Trigger.dev call.
 */
export const buildGateJobs = (
  pairs: readonly { workflow: Workflow; event: DomainEvent }[],
  existing: ReadonlySet<string>,
): GateJobs => {
  const byEvent = new Map<
    string,
    { event: DomainEvent; workflowIds: string[] }
  >();
  for (const { workflow, event } of pairs) {
    if (existing.has(triggerRunKey(workflow.id, event.id))) continue;
    const entry = byEvent.get(event.id) ?? { event, workflowIds: [] };
    entry.workflowIds.push(workflow.id);
    byEvent.set(event.id, entry);
  }

  const jobs: GateJobs = [];
  for (const { event, workflowIds } of byEvent.values()) {
    jobs.push({
      name: WORKFLOW_GATE_JOB,
      data: {
        eventId: event.id,
        teamId: event.teamId,
        organizationId: event.organizationId,
        workflowIds,
      },
      opts: {
        jobId: `wfgate-${event.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
  }
  return jobs;
};

/**
 * The trigger payload a run opens on: the event's own payload, the fact sheet
 * resolved for it, and which event fired.
 *
 * The raw payload is kept UNDERNEATH the facts rather than replaced by them.
 * Everything a run could read before this existed still reads the same, so no
 * playbook written against `documentId` had to change — and where a key
 * appears in both, the resolved fact wins, because it was read from the row
 * rather than from whatever the emitter chose to stamp months ago.
 *
 * `event_type` is written last on purpose: ours is the authoritative value.
 */
export const buildTriggerPayload = (
  event: DomainEvent,
  facts: Record<string, unknown>,
): Record<string, unknown> => ({
  ...event.payload,
  ...facts,
  event_type: event.type,
});
