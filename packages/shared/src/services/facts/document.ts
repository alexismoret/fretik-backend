import db from "../../db";
import type { DomainEvent } from "../../db/schema";
import { readRecordData } from "../collection-schema/record-io";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { emptyFactSheet, type FactSheet, type FactValue } from "./types";

/**
 * Facts about the document an event happened to.
 *
 * Everything here is already in Postgres when the event fires:
 * `syncDocumentGraph` — the only emitter of `document.uploaded` — runs INSIDE
 * the transaction that writes `document_properties` and upserts the mirror
 * record, and that transaction is the last step of a pipeline that has already
 * paid for OCR, the structured classification and the entity extraction. So
 * this resolver re-reads a finished result; it never redoes one.
 *
 * Cost: two indexed reads plus one Redis-cached field-definition lookup. The
 * first read is a single relational query fanning out over four `with:` edges
 * that all hang off indexed foreign keys; the second reconstructs the mirror
 * record's typed columns, which is the ONLY way to reach the team's own
 * extracted fields — they live in the per-collection extension table
 * `data.coll_<id>`, not in `collection_records`.
 *
 * Those custom fields are worth the second read and then some: "only invoices"
 * and "only contracts signed this quarter" are the criteria teams actually
 * write, and `customFields.document_type` answers them outright where the
 * filename and the folder answer nothing.
 */

const extensionOf = (filename: string): string | null => {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  return filename.slice(dot + 1).toLowerCase();
};

/** `null` rather than `NaN` for an unparsable decimal — a fact never lies. */
const numericOrNull = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Only values that survive a round trip through JSON unchanged become facts.
 * A `Date`, a nested object or an array of objects would each need a consumer
 * to agree on a rendering, and a fact sheet has three consumers that never
 * talk to each other — so a shape no reader can be trusted with is dropped
 * rather than half-rendered.
 */
const asFactValue = (value: unknown): FactValue | undefined => {
  if (value === null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.filter((v): v is string => typeof v === "string");
    return items.length === value.length ? items : undefined;
  }
  return undefined;
};

export const resolveDocumentFacts = async (
  event: DomainEvent,
): Promise<FactSheet> => {
  const documentId = event.payload["documentId"];
  if (typeof documentId !== "string") return emptyFactSheet(event.type);
  return documentFacts({
    documentId,
    teamId: event.teamId,
    eventType: event.type,
  });
};

/**
 * The same sheet, addressed by document instead of by event.
 *
 * The Drive filer needs these facts at the tail of the processing pipeline,
 * where there is a document and no event to hand — and minting a fake one to
 * satisfy the signature would be a lie the type system happened to accept.
 */
export const documentFacts = async (params: {
  documentId: string;
  teamId: string;
  /** What the sheet reports as its origin. Defaults to the upload event,
   * which is what the filer's document has just been through. */
  eventType?: string;
}): Promise<FactSheet> => {
  const { documentId, teamId } = params;
  const eventType = params.eventType ?? "document.uploaded";

  const document = await db.query.documents.findFirst({
    where: { id: documentId, teamId },
    columns: {
      id: true,
      originalFilename: true,
      mimeType: true,
      fileSize: true,
      folderId: true,
      source: true,
    },
    with: {
      folder: { columns: { fullPath: true } },
      uploadedBy: { columns: { name: true } },
      properties: {
        columns: {
          pageCount: true,
          documentLanguage: true,
          documentSummary: true,
          confidenceScore: true,
        },
      },
      mirrorRecord: {
        columns: { id: true, collectionId: true },
        with: {
          outgoingLinks: {
            columns: { invalidatedAt: true },
            with: { toRecord: { columns: { label: true } } },
          },
        },
      },
    },
  });
  // Deleted between the emit and the sweep, or another team's — either way
  // there is nothing to say about it, and an empty sheet is the honest
  // answer. A gate reading one decides nothing and falls open.
  if (!document) return emptyFactSheet(eventType);

  // Live edges only: a `mentions` link is invalidated rather than deleted, so
  // reading them all would keep naming an organisation the extraction has
  // since retracted.
  const mentioned = (document.mirrorRecord?.outgoingLinks ?? [])
    .filter((link) => link.invalidatedAt === null)
    .map((link) => link.toRecord?.label)
    .filter((label): label is string => label !== undefined && label !== null);
  const uniqueMentioned = [...new Set(mentioned)];

  const facts: Record<string, FactValue> = {
    documentId: document.id,
    filename: document.originalFilename,
    extension: extensionOf(document.originalFilename),
    mimeType: document.mimeType,
    sizeBytes: document.fileSize,
    folderId: document.folderId,
    folderPath: document.folder?.fullPath ?? null,
    pageCount: document.properties?.pageCount ?? 0,
    documentLanguage: document.properties?.documentLanguage ?? null,
    documentSummary: document.properties?.documentSummary ?? null,
    confidenceScore: numericOrNull(
      document.properties?.confidenceScore ?? null,
    ),
    mentionedOrganizations: uniqueMentioned,
    mentionCount: uniqueMentioned.length,
    source: document.source,
    uploadedByName: document.uploadedBy?.name ?? null,
  };

  const mirror = document.mirrorRecord;
  if (mirror) {
    // Best-effort: a team whose field definitions or extension table are in an
    // unexpected state still gets every fact above. Losing a criterion's
    // sharpness is recoverable; failing the resolver would fail the gate,
    // and a gate that throws is a gate that blocks nothing.
    try {
      const fields = await getFieldDefinitionsForTeam({
        teamId,
        collectionId: mirror.collectionId,
      });
      const data = await readRecordData({
        collectionId: mirror.collectionId,
        recordId: mirror.id,
        fields,
      });
      for (const [key, raw] of Object.entries(data)) {
        const value = asFactValue(raw);
        if (value !== undefined) facts[`customFields.${key}`] = value;
      }
    } catch (error) {
      console.warn(
        `[facts.document] custom fields unavailable for ${documentId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { eventType, facts };
};
