import type { FieldDefinition } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  buildRecordShape,
  coerceRecordValue,
  describeFieldExpectation,
} from "../../schemas/record-shape";

/**
 * Validate a record's `data` against the runtime Zod built from its type's
 * enabled field definitions. Returns the parsed data on success, throws 400
 * with the field-level issues on mismatch.
 *
 * Each present value is first run through `coerceRecordValue` (a logical
 * primitive fix — phone-as-number, count-as-string, bool-as-`"true"`) so a
 * weak model's representational slip doesn't hard-fail and loop.
 *
 * In the strict (AI / Python-SDK) write path, a key that is not a field of the
 * type is also rejected with a teaching error: `z.object` silently STRIPS
 * unknown keys, so an invented key (e.g. the model copying the SQL columns
 * `annual_value_amount`/`_currency` instead of the field key `annual_value`)
 * would otherwise vanish with no error and the model would loop blind. The
 * lenient document-mirror path (`strict: false`) keeps tolerating extra keys.
 */
export const validateRecordData = (input: {
  fieldDefs: FieldDefinition[];
  data: Record<string, unknown>;
  strict?: boolean;
}): Record<string, unknown> =>
  buildRecordDataValidator({
    fieldDefs: input.fieldDefs,
    strict: input.strict,
  }).validate(input.data);

/** A validator compiled once for one object type, applied to many rows. */
export interface RecordDataValidator {
  /** The type's fields by key — callers that already need the index reuse it. */
  readonly byKey: ReadonlyMap<string, FieldDefinition>;
  /** Same contract as {@link validateRecordData}: parsed data, or a 400 throw. */
  validate: (data: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Compile the validation of ONE object type, so a bulk write pays for it once
 * instead of once per row.
 *
 * `buildRecordShape` allocates a `zodForField` per field and a `z.object` around
 * them, and it used to run inside `validateRecordData` — i.e. inside the row
 * loop of every bulk service. A 5 000-row × 30-field write therefore built and
 * threw away 5 000 Zod schemas and 150 000 field validators to check data that
 * every row validates against identically. Nothing in the shape depends on the
 * row: it is a function of `fieldDefs` and `strict`, both loop-invariant.
 *
 * Single-row callers keep the old one-shot function above, which is now this
 * with a batch of one.
 */
export const buildRecordDataValidator = (input: {
  fieldDefs: FieldDefinition[];
  strict?: boolean;
}): RecordDataValidator => {
  const byKey = new Map(input.fieldDefs.map((d) => [d.key, d]));
  const shape = buildRecordShape(input.fieldDefs, { strict: input.strict });
  const strict = input.strict !== false;

  const validate = (data: Record<string, unknown>): Record<string, unknown> => {
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const def = byKey.get(key);
      coerced[key] = def ? coerceRecordValue(def, value) : value;
    }
    const result = shape.safeParse(coerced);

    const unknownKeys = strict
      ? Object.keys(data).filter((key) => !byKey.has(key))
      : [];

    if (result.success && unknownKeys.length === 0) return result.data;

    // "Errors that teach": name the unknown field keys + the value shape each
    // failing field expects (with the valid option values for selects) so the
    // model corrects in one step. The summary itself carries the lesson, so it
    // survives a caller that only reads `error.message` (the AI tool's `errMsg`).
    const lines: string[] = [];
    const seen = new Set<string>();
    const push = (line: string): void => {
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    };

    if (unknownKeys.length > 0) {
      const valid = [...byKey.keys()];
      const validList =
        valid.slice(0, 12).join(", ") + (valid.length > 12 ? ", …" : "");
      push(
        `Unknown field(s): ${unknownKeys.join(", ")} — not keys of this type. Use a field key from: ${validList}`,
      );
    }
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key =
          typeof issue.path[0] === "string" ? issue.path[0] : undefined;
        const def = key ? byKey.get(key) : undefined;
        push(
          def
            ? describeFieldExpectation(def)
            : `${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
      }
    }
    const summary = `Some values don't match their field — fix and retry: ${lines.join("; ")}`;
    return throwHttpError(400, badRequest(summary, lines));
  };

  return { byKey, validate };
};
