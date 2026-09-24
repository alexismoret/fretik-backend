import { WORKFLOW_TRIGGERABLE_EVENT_TYPES } from "../domain-events/event-types";
import { fact, type FactDescriptor } from "./types";

/**
 * The fact registry — one declaration per event family, feeding the same four
 * consumers the trigger registry feeds: the editor, the agent catalog, the API
 * catalog route, and the redaction pass that decides what may leave.
 *
 * Declared per FAMILY, not per event type, because the subject is what the
 * facts describe: `document.uploaded` and `document.revised` differ in what
 * happened, never in what is knowable about the file. Splitting them would
 * mean maintaining the same twelve descriptors twice and letting them drift.
 *
 * Adding a fact: append a descriptor here AND resolve it in that family's
 * resolver. A descriptor with no resolver reads `null` forever, which is why
 * anything not yet wired is marked `available: false` instead of being
 * declared optimistically.
 */

/** The families a subject can belong to — the resolver dispatch key. */
export const FACT_FAMILIES = [
  "document",
  "record",
  "link",
  "folder",
  "connector",
] as const;
export type FactFamily = (typeof FACT_FAMILIES)[number];

/**
 * Which family an event type belongs to, or null when nothing resolves it.
 *
 * `connector.*` is matched by prefix because those kinds are minted at runtime
 * (`connector.<app>.<kind>`) and can never be enumerated here — the same
 * reason `isTriggerableEventType` matches them by prefix.
 */
export const factFamilyOf = (eventType: string): FactFamily | null => {
  if (eventType.startsWith("connector.")) return "connector";
  const [prefix] = eventType.split(".");
  if (prefix === undefined) return null;
  return (FACT_FAMILIES as readonly string[]).includes(prefix)
    ? (prefix as FactFamily)
    : null;
};

/**
 * A family's facts, plus the namespace its per-team facts live under.
 *
 * `dynamicPrefix` is how a registry of fixed keys describes a set that is not
 * fixed. A team's document fields are its own — `invoice_total` for one,
 * `dossier_number` for another — so they cannot be listed here, but a consumer
 * still has to know the namespace exists and that its members are readable.
 */
export interface FactFamilyDescriptor {
  family: FactFamily;
  facts: FactDescriptor[];
  dynamicPrefix?: {
    prefix: string;
    labelKey: string;
    agentHint: string;
  };
}

export const FACT_REGISTRY: Record<FactFamily, FactFamilyDescriptor> = {
  document: {
    family: "document",
    facts: [
      fact({
        key: "documentId",
        kind: "text",
        labelKey: "facts.document.id",
        agentHint: "The document's id — pass it to the drive tools.",
      }),
      fact({
        key: "filename",
        kind: "text",
        labelKey: "facts.document.filename",
        agentHint:
          "Original filename, extension included, exactly as uploaded.",
      }),
      fact({
        key: "extension",
        kind: "text",
        labelKey: "facts.document.extension",
        agentHint:
          "Lowercased extension without the dot ('pdf', 'xlsx'); null when the name has none.",
      }),
      fact({
        key: "mimeType",
        kind: "text",
        labelKey: "facts.document.mimeType",
        agentHint: "Detected MIME type, e.g. 'application/pdf'.",
      }),
      fact({
        key: "sizeBytes",
        kind: "number",
        labelKey: "facts.document.sizeBytes",
        agentHint: "File size in bytes.",
      }),
      fact({
        key: "folderId",
        kind: "text",
        labelKey: "facts.document.folderId",
        agentHint: "Parent folder id; null at the Drive root.",
      }),
      fact({
        key: "folderPath",
        kind: "text",
        labelKey: "facts.document.folderPath",
        agentHint:
          "Full folder path, e.g. '/Accounting/2026'; null at the Drive root.",
      }),
      fact({
        key: "pageCount",
        kind: "number",
        labelKey: "facts.document.pageCount",
        agentHint:
          "Pages found by extraction; 0 for formats with no pagination.",
      }),
      fact({
        key: "documentLanguage",
        kind: "text",
        labelKey: "facts.document.language",
        agentHint:
          "ISO 639-1 two-letter code of the document's own language ('en', 'fr').",
      }),
      fact({
        key: "documentSummary",
        kind: "text",
        labelKey: "facts.document.summary",
        agentHint:
          "The extraction's factual summary of what the document is and says. The strongest signal for any 'is this mine?' judgement.",
      }),
      fact({
        key: "confidenceScore",
        kind: "number",
        labelKey: "facts.document.confidence",
        agentHint:
          "0..1 self-assessed extraction quality; null when the model would not assess itself.",
      }),
      fact({
        key: "mentionedOrganizations",
        kind: "list",
        labelKey: "facts.document.mentionedOrganizations",
        agentHint:
          "Names of the organisations the document mentions, as resolved into records.",
      }),
      fact({
        key: "mentionCount",
        kind: "number",
        labelKey: "facts.document.mentionCount",
        agentHint: "How many organisations were mentioned.",
      }),
      fact({
        key: "source",
        kind: "enum",
        labelKey: "facts.document.source",
        agentHint:
          "'uploaded' for bytes that arrived as a file, 'authored' for a document written in the app.",
      }),
      fact({
        key: "uploadedByName",
        kind: "text",
        labelKey: "facts.document.uploadedBy",
        agentHint:
          "Display name of whoever added it; null for pipeline/system writes.",
      }),
    ],
    dynamicPrefix: {
      prefix: "customFields.",
      labelKey: "facts.document.customFields",
      agentHint:
        "The team's own document fields, as extraction filled them — `customFields.<field key>`. Which keys exist is per team; read the team's field definitions to know them.",
    },
  },

  record: {
    family: "record",
    facts: [
      fact({
        key: "recordId",
        kind: "text",
        labelKey: "facts.record.id",
        agentHint: "The record's id.",
      }),
      fact({
        key: "collectionKey",
        kind: "text",
        labelKey: "facts.record.collectionKey",
        agentHint: "Key of the collection (object type) the record belongs to.",
      }),
      fact({
        key: "collectionName",
        kind: "text",
        labelKey: "facts.record.collectionName",
        agentHint: "Human name of that collection.",
      }),
      fact({
        key: "label",
        kind: "text",
        labelKey: "facts.record.label",
        agentHint: "The record's display label.",
      }),
      fact({
        key: "status",
        kind: "enum",
        labelKey: "facts.record.status",
        agentHint: "Trust status: 'confirmed', 'candidate' or 'rejected'.",
      }),
      fact({
        key: "source",
        kind: "enum",
        labelKey: "facts.record.source",
        agentHint:
          "How the record came to exist ('user_manual', 'system', 'agent', …).",
      }),
      fact({
        key: "changedFields",
        kind: "list",
        labelKey: "facts.record.changedFields",
        agentHint:
          "Field keys this event changed. Empty on creation — everything is new.",
      }),
    ],
    dynamicPrefix: {
      prefix: "fields.",
      labelKey: "facts.record.fields",
      agentHint:
        "The record's own field values — `fields.<field key>`. Which keys exist depends on its collection.",
    },
  },

  link: {
    family: "link",
    facts: [
      fact({
        key: "linkTypeKey",
        kind: "text",
        labelKey: "facts.link.typeKey",
        agentHint: "Key of the relation type, e.g. 'mentions'.",
      }),
      fact({
        key: "fromLabel",
        kind: "text",
        labelKey: "facts.link.fromLabel",
        agentHint: "Label of the record the link starts at.",
      }),
      fact({
        key: "fromCollectionKey",
        kind: "text",
        labelKey: "facts.link.fromCollectionKey",
        agentHint: "Collection key of the source record.",
      }),
      fact({
        key: "toLabel",
        kind: "text",
        labelKey: "facts.link.toLabel",
        agentHint: "Label of the record the link points at.",
      }),
      fact({
        key: "toCollectionKey",
        kind: "text",
        labelKey: "facts.link.toCollectionKey",
        agentHint: "Collection key of the target record.",
      }),
    ],
  },

  folder: {
    family: "folder",
    facts: [
      fact({
        key: "folderId",
        kind: "text",
        labelKey: "facts.folder.id",
        agentHint: "The folder's id.",
      }),
      fact({
        key: "name",
        kind: "text",
        labelKey: "facts.folder.name",
        agentHint: "Folder name.",
      }),
      fact({
        key: "fullPath",
        kind: "text",
        labelKey: "facts.folder.fullPath",
        agentHint: "Full path from the Drive root.",
      }),
      fact({
        key: "parentFolderId",
        kind: "text",
        labelKey: "facts.folder.parentId",
        agentHint: "Parent folder id; null directly under the root.",
      }),
      fact({
        key: "documentCount",
        kind: "number",
        labelKey: "facts.folder.documentCount",
        agentHint: "Documents currently in the folder.",
      }),
    ],
  },

  connector: {
    family: "connector",
    facts: [
      fact({
        key: "providerKey",
        kind: "text",
        labelKey: "facts.connector.providerKey",
        agentHint: "Which external app fired, e.g. 'gmail'.",
      }),
      fact({
        key: "eventKind",
        kind: "text",
        labelKey: "facts.connector.eventKind",
        agentHint: "The provider's own event name, e.g. 'message_received'.",
      }),
    ],
    dynamicPrefix: {
      prefix: "payload.",
      labelKey: "facts.connector.payload",
      agentHint:
        "Whatever the connector put on the event — `payload.<key>`. Shapes differ per provider and per event kind; read the connector's manifest.",
    },
  },
};

/**
 * Every declared fact for an event type, or `[]` for one nothing resolves.
 * Unavailable descriptors are filtered out — a consumer asking what it can
 * read should never be handed a key that answers `null` by construction.
 */
export const factsForEventType = (eventType: string): FactDescriptor[] => {
  const family = factFamilyOf(eventType);
  if (family === null) return [];
  return FACT_REGISTRY[family].facts.filter((f) => f.available);
};

/** The dynamic namespace an event type's facts may also carry, if any. */
export const dynamicPrefixForEventType = (
  eventType: string,
): FactFamilyDescriptor["dynamicPrefix"] => {
  const family = factFamilyOf(eventType);
  return family === null ? undefined : FACT_REGISTRY[family].dynamicPrefix;
};

/**
 * The fact catalog, per workspace event type a workflow can trigger on —
 * served alongside the trigger catalog so the editor and the builder agent see
 * the same vocabulary a criterion will actually be judged against.
 *
 * `connector.*` is absent for the reason it always is: its kinds exist only
 * once a team has connected the app, so its facts are contributed per team
 * rather than published statically.
 */
export const buildFactCatalog = (): {
  eventType: string;
  facts: FactDescriptor[];
  dynamicPrefix: FactFamilyDescriptor["dynamicPrefix"];
}[] =>
  WORKFLOW_TRIGGERABLE_EVENT_TYPES.map((eventType) => ({
    eventType,
    facts: factsForEventType(eventType),
    dynamicPrefix: dynamicPrefixForEventType(eventType),
  }));
