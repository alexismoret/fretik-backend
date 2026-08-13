/**
 * How an imported record's journal entry identifies itself.
 *
 * `domain_events.agent_key` already carries a `"<space>:<id>"` convention (a
 * workflow run stamps `workflow:<id>`), and the trigger sweep already uses it
 * to skip events a run emitted itself. An import reuses the same mechanism for
 * the same reason: LOADING HISTORY IS NOT A BUSINESS EVENT STREAM.
 *
 * Without this, importing 200 000 customers into a team that runs "when a
 * customer is created, send a welcome email" sends 200 000 emails — the
 * workflow is correct, the events are correct, and the outcome is a disaster.
 * The distinction the journal cannot make on its own is intent, so the importer
 * states it.
 *
 * Records imported this way are otherwise ordinary: they are indexed, they are
 * searchable, they appear in history. Only the trigger engine looks away.
 */
const IMPORT_AGENT_KEY_PREFIX = "import:";

export const importAgentKey = (operationId: string): string =>
  `${IMPORT_AGENT_KEY_PREFIX}${operationId}`;

export const isImportOriginated = (agentKey: string | null): boolean =>
  agentKey !== null && agentKey.startsWith(IMPORT_AGENT_KEY_PREFIX);
