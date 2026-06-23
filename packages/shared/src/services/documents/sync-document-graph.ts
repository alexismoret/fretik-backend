import { inArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { objectRecords } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import {
  type EventActor,
  emitDomainEvent,
  SYSTEM_ACTOR,
} from "../domain-events/emit";
import { resolveOrgLinkTypeId } from "../link-types/resolve";
import { createLink } from "../links/create";
import { createObjectRecord } from "../object-records/create";
import { resolveRecord } from "../object-records/match";
import { setRecordData } from "../object-records/update";
import { resolveObjectTypeId } from "../object-types/resolve";
import { MENTIONS_LINK_TYPE_KEY } from "../object-types/seed-system-types";

/** A party extracted from a document, to mirror into a linked `company` record. */
export interface DocumentGraphMention {
  name: string;
  confidence?: number;
}

/** A `company` record linked to the document, for downstream vectorize metadata. */
export interface LinkedCompany {
  id: string;
  name: string;
}

/**
 * Mirror a processed document into the unified graph — the document-pipeline
 * outbox seam. In ONE transaction (the caller scopes it to DB writes only; OCR /
 * vectorize / S3 stay outside):
 *   1. upsert the document's 1:1 `document` object-record (data = the extracted
 *      custom fields, validated leniently like pre-extraction; label = filename),
 *   2. resolve each mentioned party to a `company` record (dedup within the
 *      transaction), link it to the document via the generic `mentions` relation,
 *   3. journal `document.uploaded`, linking the mirror (subject) + every
 *      mentioned company.
 *
 * The mirror is required (the `document` type is seeded + delete-protected, so
 * its absence is a broken invariant → 500). Entity linking degrades gracefully
 * if the `company` type or `mentions` relation is somehow missing. Returns the
 * mirror id + linked companies so the caller builds vectorize metadata without
 * re-reading the graph.
 */
export const syncDocumentGraph = async (input: {
  tx?: Transaction;
  organizationId: string;
  teamId: string;
  documentId: string;
  filename: string;
  customFields: Record<string, unknown>;
  mentions: DocumentGraphMention[];
  actor?: EventActor;
}): Promise<{ mirrorRecordId: string; companies: LinkedCompany[] }> => {
  const { organizationId, teamId, documentId, filename, customFields } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (
    tx: Transaction,
  ): Promise<{ mirrorRecordId: string; companies: LinkedCompany[] }> => {
    const documentTypeId = await resolveObjectTypeId({
      organizationId,
      teamId,
      key: "document",
    });
    if (!documentTypeId) {
      return throwHttpError(
        500,
        internalError("Document object type missing for organization"),
      );
    }

    // 1. Upsert the 1:1 document mirror (data = extracted custom fields).
    const existing = await tx.query.objectRecords.findFirst({
      columns: { id: true },
      where: { documentId },
    });
    const mirror = existing
      ? await setRecordData({
          tx,
          id: existing.id,
          data: customFields,
          strict: false,
          actor,
        })
      : await createObjectRecord({
          tx,
          organizationId,
          teamId,
          objectTypeId: documentTypeId,
          data: customFields,
          labelOverride: filename,
          status: "confirmed",
          source: "system",
          strict: false,
          documentId,
          actor,
        });

    // 2. Resolve mentioned parties to `company` records + `mentions` links.
    const companies = await linkMentions({
      tx,
      organizationId,
      teamId,
      mirrorRecordId: mirror.id,
      mentions: input.mentions,
      actor,
    });

    // 3. Journal the upload, linking the mirror + every mentioned company.
    await emitDomainEvent({
      tx,
      organizationId,
      teamId,
      type: "document.uploaded",
      actor,
      subjectType: "document",
      subjectRecordId: mirror.id,
      payload: {
        documentId,
        filename,
        mentionCount: companies.length,
      },
      dedupKey: `document.uploaded:${documentId}`,
      recordLinks: [
        { recordId: mirror.id, role: "subject" },
        ...companies.map((c) => ({ recordId: c.id, role: "mentioned" })),
      ],
    });

    return { mirrorRecordId: mirror.id, companies };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};

/**
 * Resolve each mention to a `company` record and link it to the document.
 * Returns the unique linked companies (id + canonical label) for vectorize
 * metadata. Degrades to an empty list if the `company` type or `mentions`
 * relation is missing.
 */
const linkMentions = async (input: {
  tx: Transaction;
  organizationId: string;
  teamId: string;
  mirrorRecordId: string;
  mentions: DocumentGraphMention[];
  actor: EventActor;
}): Promise<LinkedCompany[]> => {
  const { tx, organizationId, teamId, mirrorRecordId, mentions, actor } = input;
  if (mentions.length === 0) return [];

  const [companyTypeId, mentionsLinkTypeId] = await Promise.all([
    resolveObjectTypeId({ organizationId, teamId, key: "company" }),
    resolveOrgLinkTypeId({ organizationId, key: MENTIONS_LINK_TYPE_KEY }),
  ]);
  if (!companyTypeId || !mentionsLinkTypeId) return [];

  const linkedIds = new Set<string>();
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;

    const resolved = await resolveRecord({
      tx,
      teamId,
      objectTypeId: companyTypeId,
      rawLabel: name,
    });
    if (linkedIds.has(resolved.recordId)) continue;
    linkedIds.add(resolved.recordId);

    await createLink({
      tx,
      organizationId,
      teamId,
      linkTypeId: mentionsLinkTypeId,
      fromRecordId: mirrorRecordId,
      toRecordId: resolved.recordId,
      props: { rawName: name },
      source: "ai_extraction",
      confidence: mention.confidence ?? null,
      actor,
    });
  }

  if (linkedIds.size === 0) return [];

  // Read canonical labels once for vectorize metadata (resolveRecord returns
  // only ids; an existing company's label can differ from the raw mention).
  const rows = await tx
    .select({ id: objectRecords.id, label: objectRecords.label })
    .from(objectRecords)
    .where(inArray(objectRecords.id, [...linkedIds]));
  return rows.map((r) => ({ id: r.id, name: r.label }));
};
