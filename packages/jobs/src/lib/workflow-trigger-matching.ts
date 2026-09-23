import type { DomainEvent, Workflow } from "@fretik/shared/db/schema";
import { eventSubscriptions } from "@fretik/shared/schemas/workflows";
import { isImportOriginated } from "@fretik/shared/services/bulk-operations/agent-key";
import { isConnectorOriginated } from "@fretik/shared/services/collection-sync/agent-key";

import { WORKFLOW_GATE_JOB } from "../queues/names";
import type { getWorkflowGateQueue } from "../queues/queues";

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

/**
 * A collection sync's writes must not fire triggers either — third instance of
 * the same mechanism, third instance of the same reason, and the one the import
 * guard predicted: a first sync of 20 000 orders would launch 20 000 runs of
 * "when an order is created, notify the customer".
 *
 * It differs from the other two in what it costs to be wrong in the OTHER
 * direction. "An order reached Delivered in the app, so do something" is a
 * genuine use for these events, and this guard refuses it — which is why the
 * plan (§4.2) pairs the guard with an explicit `record_synced` trigger type
 * rather than treating the filter as the end of the story. Filtering by default
 * and opting in deliberately is the right way round: the failure mode of
 * letting them through is a mail-out nobody can stop.
 */
export const isConnectorRecord = (event: DomainEvent): boolean =>
  isConnectorOriginated(event.agentKey);

/**
 * Config match: ANY of the workflow's subscriptions matches — type equal and
 * every filter entry equal on the payload.
 *
 * A workflow listens for a LIST because one intent rarely maps to one event:
 * "act on a document that lands in this folder" is `document.uploaded` AND
 * `document.revised`, since replacing an existing file emits the second and
 * never the first. Matching is an OR across subscriptions and an AND within
 * one, which is what makes two subscriptions of the same type with different
 * filters (two watched folders) mean what a reader expects.
 */
export const matchesEvent = (workflow: Workflow, event: DomainEvent): boolean =>
  eventSubscriptions(workflow.triggerConfig).some((subscription) => {
    if (subscription.type !== event.type) return false;
    if (!subscription.filter) return true;
    return Object.entries(subscription.filter).every(
      ([key, value]) => event.payload[key] === value,
    );
  });

/**
 * The events a sweep may still act on: not a workflow's own, not an import's,
 * not a sync's, and not written under a workflow run's conversation.
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
      !isConnectorRecord(event) &&
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
