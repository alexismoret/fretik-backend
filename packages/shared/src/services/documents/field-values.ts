import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import type {
  DocumentFieldValueSource,
  NewDocumentFieldValue,
} from "../../db/schema";
import { documentFieldValues, fieldDefinitions } from "../../db/schema";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Per-document custom field-value writes.
 *
 * Reads (e.g. `retrieve.ts`) intentionally do NOT live here — they go
 * through `db.query.documents.findFirst({ with: { fieldValues: true } })`
 * so a single SELECT pulls document, properties, entities, labels and
 * field values together.
 *
 * Apply a complete `{ fieldKey: rawValue | null }` set to a document.
 * `null` (or `undefined`) values delete the row for that key; other
 * values upsert.
 *
 * Implementation:
 *   1. Filter out keys not declared on the team's `fieldDefinitions`
 *      (avoids dangling rows if the LLM hallucinated a key).
 *   2. Partition into to-upsert and to-delete.
 *   3. Run at most two statements:
 *      - batch DELETE on `fieldKey IN (…)` for cleared keys
 *      - batch INSERT … ON CONFLICT DO UPDATE for set keys
 *
 * Optional `tx` lets callers splice this into a wider transaction (e.g.
 * `upload.ts` writes properties + field values atomically).
 */
export const setDocumentFieldValues = async (data: {
  documentId: string;
  teamId: string;
  values: Record<string, unknown>;
  source: DocumentFieldValueSource;
  tx?: Tx;
}): Promise<{ written: number; deleted: number; skipped: number }> => {
  const { documentId, teamId, values, source, tx } = data;
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return { written: 0, deleted: 0, skipped: 0 };
  }

  const executor = tx ?? db;

  const requestedKeys = entries.map(([k]) => k);
  const allowed = new Set(
    (
      await executor
        .select({ key: fieldDefinitions.key })
        .from(fieldDefinitions)
        .where(
          and(
            eq(fieldDefinitions.teamId, teamId),
            eq(fieldDefinitions.resourceType, "document"),
            inArray(fieldDefinitions.key, requestedKeys),
          ),
        )
    ).map((r) => r.key),
  );

  const toUpsert: NewDocumentFieldValue[] = [];
  const toDelete: string[] = [];
  let skipped = 0;
  for (const [fieldKey, value] of entries) {
    if (!allowed.has(fieldKey)) {
      skipped += 1;
      continue;
    }
    if (value === null || value === undefined) {
      toDelete.push(fieldKey);
    } else {
      toUpsert.push({ documentId, fieldKey, value, source });
    }
  }

  if (toUpsert.length === 0 && toDelete.length === 0) {
    return { written: 0, deleted: 0, skipped };
  }

  let deleted = 0;
  if (toDelete.length > 0) {
    const rows = await executor
      .delete(documentFieldValues)
      .where(
        and(
          eq(documentFieldValues.documentId, documentId),
          inArray(documentFieldValues.fieldKey, toDelete),
        ),
      )
      .returning({ id: documentFieldValues.id });
    deleted = rows.length;
  }

  let written = 0;
  if (toUpsert.length > 0) {
    const result = await executor
      .insert(documentFieldValues)
      .values(toUpsert)
      .onConflictDoUpdate({
        target: [documentFieldValues.documentId, documentFieldValues.fieldKey],
        set: {
          value: sql`excluded.value`,
          source: sql`excluded.source`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: documentFieldValues.id });
    written = result.length;
  }

  return { written, deleted, skipped };
};
