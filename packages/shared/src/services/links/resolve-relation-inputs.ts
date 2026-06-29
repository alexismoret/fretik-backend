import { resolveLinkTypes } from "../link-types/match";
import { resolveDocumentRecordIds } from "../object-records/resolve-document-record";

/**
 * One outgoing relation to attach to a record being created. Name the relation
 * by `relationKey` (canonicalized/created against the record's type — the AI
 * path) OR by an explicit `linkTypeId` (the UI already resolved it). Name the
 * target by a record id OR an uploaded file id (`toDocumentId` → its
 * `document_record` mirror).
 */
export interface RecordRelationInput {
  relationKey?: string;
  linkTypeId?: string;
  toRecordId?: string;
  toDocumentId?: string;
}

/** A relation input resolved to the ids `bulkCreateLinks` consumes. */
export interface ResolvedRelationTarget {
  linkTypeId: string;
  toRecordId: string;
}

/**
 * Resolve relation inputs against a FIXED source object type — fully batched:
 * ONE grouped link-type resolution (distinct keys) + ONE grouped document-mirror
 * read (distinct file ids), then a pure in-memory map per input. Returns, per
 * input position, the resolved `{ linkTypeId, toRecordId }` or null with a
 * reason in `errors`. No per-input query — UI inputs that already carry
 * `linkTypeId` + `toRecordId` resolve with zero reads. Shared by the single
 * (`createObjectRecord`) and bulk (`bulkCreateObjectRecords`) create paths.
 */
export const resolveRelationInputs = async (input: {
  organizationId: string;
  teamId: string;
  fromObjectTypeId: string;
  relations: RecordRelationInput[];
}): Promise<{
  resolved: (ResolvedRelationTarget | null)[];
  errors: { index: number; error: string }[];
}> => {
  const errors: { index: number; error: string }[] = [];
  const resolved: (ResolvedRelationTarget | null)[] = input.relations.map(
    () => null,
  );
  if (input.relations.length === 0) return { resolved, errors };

  const rawKeys = input.relations
    .filter((r) => !r.linkTypeId && r.relationKey)
    .map((r) => r.relationKey as string);
  const documentIds = input.relations
    .filter((r) => !r.toRecordId && r.toDocumentId)
    .map((r) => r.toDocumentId as string);

  const linkTypeByKey =
    rawKeys.length > 0
      ? await resolveLinkTypes({
          organizationId: input.organizationId,
          teamId: input.teamId,
          fromObjectTypeId: input.fromObjectTypeId,
          rawKeys,
        })
      : new Map<string, string>();
  const recordByDocument =
    documentIds.length > 0
      ? await resolveDocumentRecordIds({
          teamId: input.teamId,
          documentIds,
        })
      : new Map<string, string>();

  input.relations.forEach((rel, index) => {
    const linkTypeId =
      rel.linkTypeId ??
      (rel.relationKey ? linkTypeByKey.get(rel.relationKey) : undefined);
    if (!linkTypeId) {
      errors.push({
        index,
        error: "Relation needs a relationKey or a linkTypeId.",
      });
      return;
    }
    const toRecordId =
      rel.toRecordId ??
      (rel.toDocumentId ? recordByDocument.get(rel.toDocumentId) : undefined);
    if (!toRecordId) {
      errors.push({
        index,
        error:
          "Relation target not found (toRecordId, or a toDocumentId whose document is processed).",
      });
      return;
    }
    resolved[index] = { linkTypeId, toRecordId };
  });

  return { resolved, errors };
};
