import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import db from "../../db";
import { documentProperties, documents, folders } from "../../db/schema";
import { callAiService } from "../../lib/ai-service";
// The cap lives with the schema: it bounds what the API accepts from a person
// as much as what the generator writes, and sixty of these ride one filing
// decision inside a 32k context window.
import { FOLDER_DESCRIPTION_MAX_CHARS } from "../../schemas/folders";

/**
 * What a folder is for, written from what is already inside it.
 *
 * The Drive filer has to choose between "Clients" and "Contracts", and a
 * folder name rarely settles that. A description would — except that almost
 * nobody writes one, which is the whole reason the folder picker was empty in
 * the first place. So it is derived.
 *
 * It costs one cheap model call per folder per night AND NOT ONE DOCUMENT
 * READ: `document_properties.document_summary` was written by the extraction
 * pipeline when each file was uploaded, so the material is already in
 * Postgres. Re-reading the files to describe the folder would cost more than
 * every decision the description will ever inform.
 *
 * Only the documents open to whoever opens the folder are read: everyone who
 * can open the folder reads its description, so a document restricted to a
 * few people must not shape it.
 */

/** Below this, a folder has not shown what it is for. */
const MIN_DOCUMENTS = 3;
/** Summaries sampled per folder — enough to see a pattern, few enough to stay
 * one cheap call. Newest first: a folder's recent contents are what it is for
 * NOW, and a description is used to file the next thing, not the last. */
const SAMPLE_SIZE = 12;
/** Per-summary cap, matching `/internal/folder-description`'s own schema. */
const SUMMARY_MAX_CHARS = 2000;
/** New documents since the last generation before it is rewritten. A folder
 * that has gained this many may have changed what it is for, and a stale
 * description files things wrongly with complete confidence. */
const DRIFT_DOCUMENTS = 10;

const FolderDescriptionResponseSchema = z.object({
  description: z.string(),
});

/**
 * Folders due for a description: enough documents, and either never described
 * or drifted since. Manual descriptions are excluded in the WHERE clause, not
 * filtered afterwards — a person's statement of where things should go is the
 * one signal worth more than anything inferred here, and the generator must
 * never be one bug away from overwriting it.
 */
export const listFoldersToDescribe = async (params: {
  teamId: string;
  limit: number;
}): Promise<{ id: string; name: string; fullPath: string }[]> =>
  db
    .select({
      id: folders.id,
      name: folders.name,
      fullPath: folders.fullPath,
    })
    .from(folders)
    .where(
      and(
        eq(folders.teamId, params.teamId),
        sql`${folders.documentCount} >= ${MIN_DOCUMENTS}`,
        or(
          isNull(folders.descriptionSource),
          and(
            eq(folders.descriptionSource, "auto"),
            or(
              isNull(folders.descriptionDocumentCount),
              gt(
                folders.documentCount,
                sql`${folders.descriptionDocumentCount} + ${DRIFT_DOCUMENTS}`,
              ),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(folders.id))
    .limit(params.limit);

/**
 * Write (or rewrite) one folder's description.
 *
 * Returns false without calling anything when the folder has nothing to
 * describe — a folder of files that all failed extraction has summaries that
 * are empty strings, and a description generated from nothing is worse than
 * none at all, because the filer would trust it.
 */
export const describeFolder = async (params: {
  folderId: string;
  teamId: string;
  organizationId: string;
  name: string;
  fullPath: string;
}): Promise<boolean> => {
  const rows = await db
    .select({ summary: documentProperties.documentSummary })
    .from(documents)
    .innerJoin(
      documentProperties,
      eq(documentProperties.documentId, documents.id),
    )
    .where(
      and(
        eq(documents.folderId, params.folderId),
        eq(documents.teamId, params.teamId),
        eq(documents.accessRestricted, false),
        isNotNull(documentProperties.documentSummary),
      ),
    )
    .orderBy(sql`${documents.createdAt} DESC`)
    .limit(SAMPLE_SIZE);

  // Clipped to the endpoint's own per-summary cap. The pre-extract prompt
  // targets 500 characters with 1000 as its hard limit, so an over-long one
  // is rare — and rare is exactly the shape of bug that would 400 the same
  // folder every night with nobody noticing. What the model needs is the
  // PATTERN across summaries, which the opening sentences carry.
  const summaries = rows
    .map((r) => r.summary.trim().slice(0, SUMMARY_MAX_CHARS))
    .filter((s) => s.length > 0);
  if (summaries.length < MIN_DOCUMENTS) return false;

  const result = await callAiService(
    "/internal/folder-description",
    {
      folderName: params.name,
      folderPath: params.fullPath,
      summaries,
      maxChars: FOLDER_DESCRIPTION_MAX_CHARS,
    },
    FolderDescriptionResponseSchema,
    { teamId: params.teamId, organizationId: params.organizationId },
    { timeoutMs: 60_000 },
  );

  const description = result.description
    .trim()
    .slice(0, FOLDER_DESCRIPTION_MAX_CHARS);
  if (description.length === 0) return false;

  // The "never written by anyone else" guard rides the UPDATE itself: a
  // person or the assistant may have written one between the read above and
  // here, and a read-then-write check would lose that race silently.
  const [updated] = await db
    .update(folders)
    .set({
      description,
      descriptionSource: "auto",
      descriptionGeneratedAt: new Date(),
      descriptionDocumentCount: sql`${folders.documentCount}`,
    })
    .where(
      and(
        eq(folders.id, params.folderId),
        eq(folders.teamId, params.teamId),
        or(
          isNull(folders.descriptionSource),
          eq(folders.descriptionSource, "auto"),
        ),
      ),
    )
    .returning({ id: folders.id });
  return updated !== undefined;
};
