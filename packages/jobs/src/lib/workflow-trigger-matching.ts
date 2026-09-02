import type { DomainEvent, Workflow } from "@fretik/shared/db/schema";
import { isImportOriginated } from "@fretik/shared/services/bulk-operations/agent-key";

import { WORKFLOW_RUN_CREATE_JOB } from "../queues/names";
import type { getWorkflowTriggerQueue } from "../queues/queues";

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

/** A run's own journal writes must never trigger another run. */
export const isWorkflowOriginated = (event: DomainEvent): boolean =>
  event.actorType === "workflow" ||
  (event.agentKey !== null && event.agentKey.startsWith("workflow:"));

/**
 * A bulk import's writes must not fire triggers either — same mechanism, same
 * `agentKey` convention, different reason: see `bulk-operations/agent-key.ts`.
 * A 200 000-row load is history being entered, not 200 000 things happening.
 */
export const isImportedRecord = (event: DomainEvent): boolean =>
  isImportOriginated(event.agentKey);

/** Config match: event type equal + every filter entry equal on the payload. */
export const matchesEvent = (
  workflow: Workflow,
  event: DomainEvent,
): boolean => {
  const config = workflow.triggerConfig.event;
  if (!config || config.type !== event.type) return false;
  if (!config.filter) return true;
  return Object.entries(config.filter).every(
    ([key, value]) => event.payload[key] === value,
  );
};

/**
 * The events a sweep may still act on: not a workflow's own, not an import's,
 * and not written under a workflow run's conversation.
 *
 * That third exclusion is the one that actually closes the self-trigger loop.
 * A run's SDK and sub-agent writes journal under the run's OWN conversation
 * and carry neither `actorType 'workflow'` nor a `workflow:` agent key, so the
 * first two predicates let them straight through.
 *
 * `workflowConversationIds` is supplied by the caller because deciding which
 * conversations belong to a run is a query; deciding what to do about it is
 * not.
 */
export const selectTriggerCandidates = (
  events: readonly DomainEvent[],
  workflowConversationIds: ReadonlySet<string>,
): DomainEvent[] =>
  events.filter(
    (event) =>
      !isWorkflowOriginated(event) &&
      !isImportedRecord(event) &&
      (event.conversationId === null ||
        !workflowConversationIds.has(event.conversationId)),
  );

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

type TriggerJobs = Parameters<
  ReturnType<typeof getWorkflowTriggerQueue>["addBulk"]
>[0];

/**
 * The jobs to enqueue for a set of pairs, minus the ones that already have a
 * run.
 *
 * Three things dedup a re-swept event, and they must agree on one identity:
 * the partial unique index on `(workflow_id, source_event_id)` in Postgres,
 * the `existing` set read in one query before this call, and the BullMQ
 * `jobId`. If the jobId ever stopped matching the run key, a replayed batch
 * would enqueue duplicates that only the database would catch — as a failed
 * job, after the Trigger.dev call.
 */
export const buildTriggerJobs = (
  pairs: readonly { workflow: Workflow; event: DomainEvent }[],
  existing: ReadonlySet<string>,
): TriggerJobs => {
  const jobs: TriggerJobs = [];
  for (const { workflow, event } of pairs) {
    if (existing.has(triggerRunKey(workflow.id, event.id))) continue;
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
  return jobs;
};
