import { and, eq } from "drizzle-orm";
import db from "../../db";
import { aiVectors } from "../../db/schema";

/**
 * Drop a record's card from the recall index (record deleted, rejected, or
 * no longer confirmed). Direct SQL — nothing to embed, no AI-service
 * roundtrip. Mirror of `services/episodes/vectors.ts`; the card comes back
 * through the idempotent vectorize pipeline if the record is re-confirmed.
 */
export const deleteRecordCardVectors = async (
  recordId: string,
): Promise<void> => {
  await db
    .delete(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "records"),
        eq(aiVectors.sourceId, recordId),
      ),
    );
};
