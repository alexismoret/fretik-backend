import { eq } from "drizzle-orm";
import type { Executor } from "../../db";
import type { FieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { formatBulkRowError } from "../../lib/db-bulk";
import { badRequest, throwHttpError } from "../../lib/errors";
import { resolveFormulaConfig } from "../field-definitions/formula-config";

/**
 * Compile the `formula` fields of a freshly-created collection and persist the
 * `resultType` the compiler inferred, returning the rows as they now stand.
 *
 * The single-field path (`createFieldDefinition`) does this through
 * `resolveFormulaConfig` before its INSERT; a batch create could not, because
 * a formula's siblings are the very rows being inserted. So it runs here, in
 * the same transaction, right after the INSERT and before the DDL — the first
 * moment the sibling set exists and the last moment before it is compiled into
 * a generated column.
 *
 * A refusal rolls the whole transaction back, so a half-built type is still
 * impossible.
 */
export const resolveBatchFormulas = async (input: {
  tx: Executor;
  fields: FieldDefinition[];
}): Promise<FieldDefinition[]> => {
  const formulas = input.fields.filter((f) => f.type === "formula");
  if (formulas.length === 0) return input.fields;

  const resolvedById = new Map<string, FieldDefinition>();
  for (const field of formulas) {
    const config = compileOrExplain({ field, siblings: input.fields });
    const [row] = await input.tx
      .update(fieldDefinitions)
      .set({ config })
      .where(eq(fieldDefinitions.id, field.id))
      .returning();
    if (row) resolvedById.set(row.id, row);
  }
  return input.fields.map((f) => resolvedById.get(f.id) ?? f);
};

/**
 * `resolveFormulaConfig`, with the batch's own keys added to the refusal.
 *
 * Keys are derived from labels here, so an agent composing a create batch is
 * guessing at what its own formula must name — and in the incident of
 * 2026-08-28 it guessed in the source language of the file rather than the
 * labels it had just written, three times over. Listing what the batch
 * actually declared turns a retry into a correction.
 */
const compileOrExplain = (input: {
  field: FieldDefinition;
  siblings: FieldDefinition[];
}): FieldDefinition["config"] => {
  try {
    return resolveFormulaConfig({
      config: input.field.config,
      siblings: input.siblings,
      label: input.field.label,
    });
  } catch (error) {
    const keys = input.siblings
      .filter((f) => f.type !== "formula")
      .map((f) => f.key)
      .join(", ");
    return throwHttpError(
      400,
      badRequest(
        `${formatBulkRowError(error)} Fields in this collection: ${keys}.`,
      ),
    );
  }
};
