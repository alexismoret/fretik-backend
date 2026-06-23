import type { FieldDefinition } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import { buildRecordShape } from "../../schemas/record-shape";

/**
 * Validate a record's `data` against the runtime Zod built from its type's
 * enabled field definitions. Returns the parsed data on success, throws 400
 * with the field-level issues on mismatch.
 */
export const validateRecordData = (input: {
  fieldDefs: FieldDefinition[];
  data: Record<string, unknown>;
  strict?: boolean;
}): Record<string, unknown> => {
  const shape = buildRecordShape(input.fieldDefs, { strict: input.strict });
  const result = shape.safeParse(input.data);
  if (!result.success) {
    const details = result.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    return throwHttpError(400, badRequest("Invalid record data", details));
  }
  return result.data;
};
