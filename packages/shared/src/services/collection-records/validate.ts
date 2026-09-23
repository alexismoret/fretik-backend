import type { FieldDefinition } from "../../db/schema";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  buildRecordShape,
  coerceRecordValue,
  describeFieldExpectation,
  isSyncedField,
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
  /** See {@link buildRecordDataValidator} — the sync runner's capability. */
  allowSyncedFields?: boolean;
  syncSourceApps?: ReadonlyMap<string, string>;
  /** The record's stored values, when this write is an update. */
  previous?: Record<string, unknown>;
}): Record<string, unknown> =>
  buildRecordDataValidator({
    fieldDefs: input.fieldDefs,
    strict: input.strict,
    allowSyncedFields: input.allowSyncedFields,
    syncSourceApps: input.syncSourceApps,
  }).validate(input.data, input.previous);

/** A validator compiled once for one collection, applied to many rows. */
export interface RecordDataValidator {
  /** The type's fields by key — callers that already need the index reuse it. */
  readonly byKey: ReadonlyMap<string, FieldDefinition>;
  /**
   * Same contract as {@link validateRecordData}: parsed data, or a 400 throw.
   * `previous` is the row's STORED values on an update path — the basis of the
   * synced-column guard, and what a full replace pins back.
   */
  validate: (
    data: Record<string, unknown>,
    previous?: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * One refusal line, naming the app rather than the rule.
 *
 * "Errors that teach", applied to a column somebody cannot edit: the useful
 * sentence says where the value DOES come from and what the two ways out are,
 * because a user staring at a greyed cell has no other way to learn either.
 * The app name is absent only when the source row could not be read, which is
 * a degraded message and never a missing refusal.
 */
const refuseSyncedField = (key: string, app: string | undefined): string =>
  app === undefined
    ? `"${key}" is filled by a connected app and cannot be edited here. Change it in that app, or detach the column from its sync source.`
    : `"${key}" is filled by ${app} and cannot be edited here. Change it in ${app}, or detach the column from its sync source.`;

/** Value equality for "did this write CHANGE the column" — shape-insensitive. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
};

/**
 * Compile the validation of ONE collection, so a bulk write pays for it once
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
 *
 * THE SYNCED-COLUMN GUARD. A field with `syncSourceId` is filled by a connected
 * app; users, agents and page forms may read it and nothing more. Three rules,
 * and the second two exist because a write is not only what it names:
 *
 *  1. an incoming value that DIFFERS from the stored one is refused by name;
 *  2. an incoming value EQUAL to the stored one passes — the record editor
 *     sends the whole row back on every cell edit, and refusing that would
 *     make a collection with one synced column uneditable;
 *  3. the stored value is pinned back into the parsed data. `buildRecordShape`
 *     dropped the key, and `record-io`'s `replace` mode writes NULL into every
 *     scalar column absent from `data` — so without the pin, editing any other
 *     cell would silently erase the app's column.
 *
 * `allowSyncedFields` is the sync runner's capability, and it is passed
 * EXPLICITLY rather than derived from `actor.actorType === "connector"`: that
 * actor is also what the CSV import ledger and the approval executor write
 * under, and neither of them may touch a synced column.
 */
export const buildRecordDataValidator = (input: {
  fieldDefs: FieldDefinition[];
  strict?: boolean;
  allowSyncedFields?: boolean;
  /** `syncSourceId` → the app's display name, for a refusal that names it. */
  syncSourceApps?: ReadonlyMap<string, string>;
}): RecordDataValidator => {
  const byKey = new Map(input.fieldDefs.map((d) => [d.key, d]));
  const allowSyncedFields = input.allowSyncedFields === true;
  const shape = buildRecordShape(input.fieldDefs, {
    strict: input.strict,
    allowSyncedFields,
  });
  const strict = input.strict !== false;
  // Empty for the sync runner and for every collection nothing feeds, which is
  // almost all of them — the guard below then costs one `.length` test per row.
  const syncedDefs = allowSyncedFields
    ? []
    : input.fieldDefs.filter((def) => def.enabled && isSyncedField(def));

  const validate = (
    data: Record<string, unknown>,
    previous?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const coerced: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const def = byKey.get(key);
      coerced[key] = def ? coerceRecordValue(def, value) : value;
    }

    const refusals: string[] = [];
    for (const def of syncedDefs) {
      if (!(def.key in coerced)) continue;
      const stored = previous ? previous[def.key] : undefined;
      if (sameValue(coerced[def.key], stored)) continue;
      refusals.push(
        refuseSyncedField(
          def.key,
          def.syncSourceId === null
            ? undefined
            : input.syncSourceApps?.get(def.syncSourceId),
        ),
      );
    }
    if (refusals.length > 0) {
      return throwHttpError(400, badRequest(refusals.join(" "), refusals));
    }

    const result = shape.safeParse(coerced);

    const unknownKeys = strict
      ? Object.keys(data).filter((key) => !byKey.has(key))
      : [];

    if (result.success && unknownKeys.length === 0) {
      return pinSyncedValues(result.data, syncedDefs, previous);
    }

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
        `Unknown field(s): ${unknownKeys.join(", ")}. These are not keys of this type. Use a field key from: ${validList}`,
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
    const summary = `Some values don't match their field. Fix them and retry: ${lines.join("; ")}`;
    return throwHttpError(400, badRequest(summary, lines));
  };

  return { byKey, validate };
};

/**
 * Rule 3 of the guard: carry the app's own values through a write that was not
 * allowed to name them. A no-op for the sync runner (nothing in `syncedDefs`)
 * and for a create (nothing stored yet).
 */
const pinSyncedValues = (
  parsed: Record<string, unknown>,
  syncedDefs: FieldDefinition[],
  previous: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  if (syncedDefs.length === 0 || previous === undefined) return parsed;
  const pinned = { ...parsed };
  for (const def of syncedDefs) {
    if (def.key in previous) pinned[def.key] = previous[def.key];
  }
  return pinned;
};
