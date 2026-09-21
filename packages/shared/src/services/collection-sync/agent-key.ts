import type { EventActor } from "../domain-events/emit";

/**
 * How a sync's journal entry identifies itself.
 *
 * `domain_events.agent_key` already carries a `"<space>:<id>"` convention — a
 * workflow run stamps `workflow:<id>`, a bulk import stamps `import:<id>`, and
 * the trigger sweep skips both. A sync reuses the same mechanism for the same
 * reason, restated once more because it has now been learnt twice:
 *
 *   A FIRST SYNC IS NOT AN EVENT STREAM. Seeding a collection with 20 000
 *   orders would otherwise fire 20 000 runs of "when an order is created,
 *   notify the customer". The workflow is correct, the events are correct, and
 *   the outcome is a disaster — the same shape the `import:` guard already
 *   fixed once (`bulk-operations/agent-key.ts`).
 *
 * The events themselves are ordinary: the records are indexed, searchable, and
 * visible in history. Only the trigger engine looks away — and only until the
 * explicit `record_synced` trigger type exists to opt back in deliberately
 * (plan §4.2, recommendation 1).
 */
const CONNECTOR_AGENT_KEY_PREFIX = "connector:";

export const connectorAgentKey = (syncSourceId: string): string =>
  `${CONNECTOR_AGENT_KEY_PREFIX}${syncSourceId}`;

export const isConnectorOriginated = (agentKey: string | null): boolean =>
  agentKey !== null && agentKey.startsWith(CONNECTOR_AGENT_KEY_PREFIX);

/**
 * The actor every write of a run carries. `connector` is also what
 * `collection_records.created_by_actor` and `source` record, so a row's
 * provenance says which app filled it without joining anything.
 */
export const syncActor = (syncSourceId: string): EventActor => ({
  actorType: "connector",
  agentKey: connectorAgentKey(syncSourceId),
});
