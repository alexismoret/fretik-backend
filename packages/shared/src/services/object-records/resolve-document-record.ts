import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";

/**
 * Batch resolve uploaded file ids (`documents.id`) to their 1:1 mirror object
 * records (`object_records.id` of the `document_record` type) in ONE query. The
 * `links` graph connects records to records, never to a raw `documents` row — so
 * to relate any record to an uploaded file you link to that file's mirror
 * record. Mirrors are created by the document fold (`sync-document-graph`),
 * unique per file (`object_records_document_uniq`).
 *
 * Team-scoped: a file with no mirror yet (the fold has not run, or it belongs to
 * another team) is simply absent from the returned map. Use this over the
 * single-id helper whenever resolving many files (bulk record relations) so the
 * work is one round-trip, never one per file.
 */
export const resolveDocumentRecordIds = async (input: {
  documentIds: string[];
  teamId: string;
}): Promise<Map<string, string>> => {
  const ids = [...new Set(input.documentIds)];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;

  const rows = await db
    .select({ id: objectRecords.id, documentId: objectRecords.documentId })
    .from(objectRecords)
    .where(
      and(
        eq(objectRecords.teamId, input.teamId),
        inArray(objectRecords.documentId, ids),
      ),
    );
  for (const r of rows) {
    if (r.documentId) map.set(r.documentId, r.id);
  }
  return map;
};

/** Single-id convenience over {@link resolveDocumentRecordIds}. */
export const resolveDocumentRecordId = async (input: {
  documentId: string;
  teamId: string;
}): Promise<string | null> => {
  const map = await resolveDocumentRecordIds({
    documentIds: [input.documentId],
    teamId: input.teamId,
  });
  return map.get(input.documentId) ?? null;
};
