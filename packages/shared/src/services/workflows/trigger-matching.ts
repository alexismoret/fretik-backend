import type { DomainEvent, Workflow } from "../../db/schema";
import { eventSubscriptions } from "../../schemas/workflows";
import { isImportOriginated } from "../bulk-operations/agent-key";
import { isConnectorOriginated } from "../collection-sync/agent-key";

/**
 * Which events a workflow's event trigger answers — pure predicates, no
 * database.
 *
 * Two callers need exactly the same answer: the jobs sweep that launches runs,
 * and the "test the condition" backtest that replays a criterion over the
 * events a workflow WOULD have seen. A backtest over a different notion of
 * "matching event" would show a verdict for firings that never happen, so the
 * rules live here once and the sweep re-exports them.
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
export const matchesEvent = (
  workflow: Pick<Workflow, "triggerConfig">,
  event: DomainEvent,
): boolean =>
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
