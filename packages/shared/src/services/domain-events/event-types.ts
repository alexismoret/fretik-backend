/**
 * The registry of journal event types. `domain_events.type` stays free text in
 * the DB (connectors/workflows mint kinds without a migration), but every
 * code-emitted type must either be listed here or live under a reserved
 * namespace — `assertValidDomainEventType` enforces it at the emit seam, so a
 * typo'd type throws in dev instead of silently fragmenting the journal.
 */
export const DOMAIN_EVENT_TYPES = [
  // Record lifecycle (record.merged reserved for the future merge flow).
  "record.created",
  "record.updated",
  "record.deleted",
  "record.confirmed",
  "record.rejected",
  "record.merged",
  // Typed edges between records.
  "link.created",
  "link.invalidated",
  // Documents (Drive).
  "document.uploaded",
  /**
   * The document's CONTENT changed — someone edited it, the agent rewrote it,
   * a newer file replaced it, or a version was restored. One type for the
   * three, with `operation` in the payload: what a workflow reacts to is "these
   * bytes are not the bytes I last checked", which is the same fact however it
   * happened. `document.uploaded` still covers the first version, so creating a
   * document emits one event, not two.
   */
  "document.revised",
  "document.deleted",
  "document.reextracted",
  // Conversations + agent turns.
  "chat.turn",
  "conversation.created",
  "conversation.deleted",
  // Ontology catalog mutations.
  "collection.created",
  "collection.updated",
  "collection.deleted",
  "field.created",
  "field.updated",
  "field.deleted",
  "link_type.created",
  "link_type.updated",
  "link_type.deleted",
  // Folder hierarchy.
  "folder.created",
  "folder.renamed",
  "folder.deleted",
  // Agent-curated memory store.
  "memory.created",
  "memory.updated",
  "memory.renamed",
  "memory.deleted",
  // Distilled episodic memory.
  "episode.created",
  "episode.consolidated",
  "episode.unsuperseded",
  "episode.demoted",
  "episode.deleted",
  "episode.purged",
  // Skills catalogue.
  "skill.created",
  "skill.updated",
  "skill.deleted",
  // External-app connection lifecycle (the config actions on OUR side).
  "connector.connected",
  "connector.disconnected",
] as const;

export type KnownDomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/**
 * Namespaces reserved for event families minted at runtime without a code
 * change:
 * - `connector.` — provider-originated external-app activity, convention
 *   `connector.<providerKey>.<eventKind>` (e.g. `connector.gmail.message_received`,
 *   `connector.ms-planner.task_created`). These are the events an inbound
 *   email/task/etc. lands as, and the future trigger engine's primary sources.
 * - `workflow.` — the future workflow engine's run lifecycle
 *   (`workflow.run.started`, `workflow.run.finished`).
 * - `trigger.` — trigger firings (`trigger.cron`, `trigger.manual`,
 *   `trigger.external`).
 */
export const DOMAIN_EVENT_NAMESPACES = [
  "connector.",
  "workflow.",
  "trigger.",
] as const;

/** What `emitDomainEvent` accepts: a known type or a namespaced runtime kind. */
export type DomainEventType =
  | KnownDomainEventType
  | `connector.${string}`
  | `workflow.${string}`
  | `trigger.${string}`;

const KNOWN_TYPES: ReadonlySet<string> = new Set(DOMAIN_EVENT_TYPES);

export const isValidDomainEventType = (type: string): boolean =>
  KNOWN_TYPES.has(type) ||
  DOMAIN_EVENT_NAMESPACES.some(
    (ns) => type.startsWith(ns) && type.length > ns.length,
  );

/**
 * The subset of journal events a workflow may TRIGGER on — "things that happen
 * to the team's content". Excludes internal plumbing (catalog/config/memory
 * churn, chat turns) and, deliberately, `workflow.*` (a run's own lifecycle —
 * triggering on it would risk self-firing loops). `connector.*` provider
 * activity (an inbound email/task/etc.) is matched by prefix because those
 * kinds are minted at runtime. Used to validate a workflow's event trigger so
 * a typo'd type can't silently create a workflow that never fires.
 */
export const WORKFLOW_TRIGGERABLE_EVENT_TYPES = [
  "document.uploaded",
  "document.revised",
  "document.deleted",
  "document.reextracted",
  "record.created",
  "record.updated",
  "record.deleted",
  "record.confirmed",
  "record.rejected",
  "link.created",
  "link.invalidated",
  "folder.created",
  "folder.renamed",
  "folder.deleted",
] as const;

const TRIGGERABLE_TYPES: ReadonlySet<string> = new Set(
  WORKFLOW_TRIGGERABLE_EVENT_TYPES,
);

/** True for a curated workspace event type or any `connector.*` provider kind. */
export const isTriggerableEventType = (type: string): boolean =>
  TRIGGERABLE_TYPES.has(type) ||
  (type.startsWith("connector.") && type.length > "connector.".length);

/**
 * Emit-time guard: throw in dev/test (fail fast on a typo), warn in prod (a
 * mislabeled journal entry beats a failed user mutation).
 */
export const assertValidDomainEventType = (type: string): void => {
  if (isValidDomainEventType(type)) return;
  const message = `[domain-events] unknown event type "${type}" — add it to DOMAIN_EVENT_TYPES or use a reserved namespace (${DOMAIN_EVENT_NAMESPACES.join(" ")})`;
  if (process.env.NODE_ENV === "production") {
    console.warn(message);
    return;
  }
  throw new Error(message);
};
