import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";

/**
 * Which of these ids are records of THIS collection, owned by THIS team.
 *
 * The bulk write services answer the team half on their own, because that is
 * the tenancy every caller has. The collection half only matters where a write
 * was described before its rows arrived — a streamed load, or an HTTP bulk
 * call that names its target in the body. There, "the collection" is not a
 * label: it sized the chunks, it is what the approval card named, and it is
 * what the caller believes it is writing to. An id from elsewhere has to come
 * back as a refusal rather than as a silent write into another table.
 *
 * Chunked, so a 5 000-id call stays under the parameter ceiling.
 */
export const idsInCollection = async (input: {
  teamId: string;
  collectionId: string;
  ids: string[];
}): Promise<Set<string>> => {
  const found = new Set<string>();
  if (input.ids.length === 0) return found;
  for (const idChunk of chunkForBulk([...new Set(input.ids)])) {
    const rows = await db
      .select({ id: collectionRecords.id })
      .from(collectionRecords)
      .where(
        and(
          inArray(collectionRecords.id, idChunk),
          eq(collectionRecords.teamId, input.teamId),
          eq(collectionRecords.collectionId, input.collectionId),
        ),
      );
    for (const row of rows) found.add(row.id);
  }
  return found;
};
