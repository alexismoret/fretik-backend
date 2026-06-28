import { and, eq } from "drizzle-orm";
import db from "../../db";
import { objectRecords } from "../../db/schema";

/**
 * Resolve an uploaded file's id (`documents.id`) to its 1:1 mirror object record
 * (`object_records.id` of the `document_record` type). The `links` graph connects
 * records to records, never to a raw `documents` row — so to relate any record to
 * an uploaded file you link to that file's mirror record. The mirror is created
 * by the document fold (`sync-document-graph`) and is unique per file
 * (`object_records_document_uniq`).
 *
 * Team-scoped: returns null when no mirror exists for this team's file yet (the
 * fold has not run, or the file belongs to another team).
 */
export const resolveDocumentRecordId = async (input: {
  documentId: string;
  teamId: string;
}): Promise<string | null> => {
  const row = await db
    .select({ id: objectRecords.id })
    .from(objectRecords)
    .where(
      and(
        eq(objectRecords.documentId, input.documentId),
        eq(objectRecords.teamId, input.teamId),
      ),
    )
    .limit(1);
  return row[0]?.id ?? null;
};
