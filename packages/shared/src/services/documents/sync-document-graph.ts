import { inArray } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { objectRecords } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import { selectOrCache } from "../../lib/redis";
import { MENTION_MIN_CONFIDENCE } from "../../lib/resolution";
import {
  emitDomainEvent,
  SYSTEM_ACTOR,
  type EventActor,
} from "../domain-events/emit";
import { resolveOrgLinkTypeId } from "../link-types/resolve";
import { bulkCreateLinks, type LinkInput } from "../links/bulk-create";
import { createObjectRecord } from "../object-records/create";
import { resolveRecord } from "../object-records/match";
import { setRecordData } from "../object-records/update";
import { DOCUMENT_TYPE_KEY } from "../object-types/constants";
import { resolveObjectTypeId } from "../object-types/resolve";
import { MENTIONS_LINK_TYPE_KEY } from "../object-types/seed-system-types";

/** A party extracted from a document, mirrored into a linked mention-target record. */
export interface DocumentGraphMention {
  name: string;
  confidence?: number;
}

/** A record the document was folded into (the mention target), for vectorize metadata. */
export interface LinkedMention {
  id: string;
  name: string;
}

/**
 * Resolve the object type extracted parties are folded into. Configurable per
 * org (`organization_settings.document_mention_target_type_key`); falls back to
 * `company` for back-compat. Decoupled from a hardcoded `company` so a team can
 * retarget extraction and deleting `company` degrades gracefully. Cached 30 min
 * (config, rarely changed) under `organization:{orgId}:document-mention-target`.
 */
const resolveMentionTargetTypeKey = async (
  organizationId: string,
): Promise<string> =>
  selectOrCache(async () => {
    const settings = await db.query.organizationSettings.findFirst({
      columns: { documentMentionTargetTypeKey: true },
      where: { organizationId },
    });
    return settings?.documentMentionTargetTypeKey ?? "company";
  }, `organization:${organizationId}:document-mention-target`);

/**
 * Mirror a processed document into the unified graph — the document-pipeline
 * outbox seam. In ONE transaction (the caller scopes it to DB writes only; OCR /
 * vectorize / S3 stay outside):
 *   1. upsert the document's 1:1 `document` object-record (data = the extracted
 *      custom fields, validated leniently like pre-extraction; label = filename),
 *   2. resolve each mentioned party to a record of the configured mention-target
 *      type (dedup within the transaction), link it to the document via the
 *      generic `mentions` relation,
 *   3. journal `document.uploaded`, linking the mirror (subject) + every
 *      mentioned record.
 *
 * The mirror is required (the `document` type is seeded + delete-protected, so
 * its absence is a broken invariant → 500). Entity linking degrades gracefully
 * if the mention-target type or `mentions` relation is missing. Returns the
 * mirror id + linked records so the caller builds vectorize metadata without
 * re-reading the graph.
 */
export const syncDocumentGraph = async (input: {
  tx?: Transaction;
  organizationId: string;
  teamId: string;
  documentId: string;
  /** The uploaded document's parent folder (NULL = Drive root). Journaled into
   * the `document.uploaded` payload so an event trigger can scope to a folder
   * (`event.filter.folderId`). */
  folderId?: string | null;
  filename: string;
  customFields: Record<string, unknown>;
  mentions: DocumentGraphMention[];
  actor?: EventActor;
}): Promise<{
  mirrorRecordId: string;
  mentionedRecords: LinkedMention[];
  mentionTargetTypeKey: string;
}> => {
  const { organizationId, teamId, documentId, filename, customFields } = input;
  const actor = input.actor ?? SYSTEM_ACTOR;

  const run = async (
    tx: Transaction,
  ): Promise<{
    mirrorRecordId: string;
    mentionedRecords: LinkedMention[];
    mentionTargetTypeKey: string;
  }> => {
    const documentTypeId = await resolveObjectTypeId({
      organizationId,
      teamId,
      key: DOCUMENT_TYPE_KEY,
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
      ? // Re-processing (e.g. re-extraction): PATCH only the extracted fields so
        // the `name` title (defaults to the filename, may be user-renamed) and any
        // other non-extracted field survive.
        await setRecordData({
          tx,
          id: existing.id,
          data: customFields,
          merge: true,
          strict: false,
          actor,
        })
      : await createObjectRecord({
          tx,
          organizationId,
          teamId,
          objectTypeId: documentTypeId,
          // Seed the `name` title from the filename; `labelOverride` keeps the
          // record label correct even before the `name` field def exists.
          data: { ...customFields, name: filename },
          labelOverride: filename,
          status: "confirmed",
          source: "system",
          strict: false,
          documentId,
          actor,
        });

    // 2. Resolve mentioned parties to mention-target records + `mentions` links.
    const mentionTargetTypeKey =
      await resolveMentionTargetTypeKey(organizationId);
    const mentionedRecords = await linkMentions({
      tx,
      organizationId,
      teamId,
      targetTypeKey: mentionTargetTypeKey,
      mirrorRecordId: mirror.id,
      mentions: input.mentions,
      actor,
    });

    // 3. Journal the upload, linking the mirror + every mentioned record.
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
        folderId: input.folderId ?? null,
        mentionCount: mentionedRecords.length,
      },
      dedupKey: `document.uploaded:${documentId}`,
      recordLinks: [
        { recordId: mirror.id, role: "subject" },
        ...mentionedRecords.map((c) => ({ recordId: c.id, role: "mentioned" })),
      ],
    });

    return {
      mirrorRecordId: mirror.id,
      mentionedRecords,
      mentionTargetTypeKey,
    };
  };

  return input.tx ? run(input.tx) : db.transaction(run);
};

/**
 * Resolve each mention to a record of the configured mention-target type and
 * link it to the document. Returns the unique linked records (id + canonical
 * label) for vectorize metadata. Degrades to an empty list if the target type
 * or the `mentions` relation is missing (e.g. the team deleted the type).
 */
const linkMentions = async (input: {
  tx: Transaction;
  organizationId: string;
  teamId: string;
  targetTypeKey: string;
  mirrorRecordId: string;
  mentions: DocumentGraphMention[];
  actor: EventActor;
}): Promise<LinkedMention[]> => {
  const {
    tx,
    organizationId,
    teamId,
    targetTypeKey,
    mirrorRecordId,
    mentions,
    actor,
  } = input;
  if (mentions.length === 0) return [];

  const [targetTypeId, mentionsLinkTypeId] = await Promise.all([
    resolveObjectTypeId({ organizationId, teamId, key: targetTypeKey }),
    resolveOrgLinkTypeId({ organizationId, key: MENTIONS_LINK_TYPE_KEY }),
  ]);
  if (!targetTypeId || !mentionsLinkTypeId) return [];

  // Resolve each mention to a target record (fuzzy entity matching), deduped,
  // collecting the edges — then write them all in ONE set-based call.
  const linkedIds = new Set<string>();
  const linkInputs: LinkInput[] = [];
  for (const mention of mentions) {
    const name = mention.name.trim();
    if (!name) continue;

    // A low-confidence mention may still link to an EXISTING record, but must
    // not create a fresh `suggested` stub — keeps the review queue signal-heavy.
    const createIfMissing = (mention.confidence ?? 1) >= MENTION_MIN_CONFIDENCE;
    const resolved = await resolveRecord({
      tx,
      teamId,
      objectTypeId: targetTypeId,
      rawLabel: name,
      createIfMissing,
    });
    if (!resolved.recordId) continue;
    if (linkedIds.has(resolved.recordId)) continue;
    linkedIds.add(resolved.recordId);

    linkInputs.push({
      linkTypeId: mentionsLinkTypeId,
      fromRecordId: mirrorRecordId,
      toRecordId: resolved.recordId,
      props: { rawName: name },
      confidence: mention.confidence ?? null,
    });
  }

  if (linkInputs.length === 0) return [];

  await bulkCreateLinks({
    tx,
    organizationId,
    teamId,
    links: linkInputs,
    source: "ai_extraction",
    actor,
  });

  // Read canonical labels once for vectorize metadata (resolveRecord returns
  // only ids; an existing company's label can differ from the raw mention).
  const rows = await tx
    .select({ id: objectRecords.id, label: objectRecords.label })
    .from(objectRecords)
    .where(inArray(objectRecords.id, [...linkedIds]));
  return rows.map((r) => ({ id: r.id, name: r.label }));
};
