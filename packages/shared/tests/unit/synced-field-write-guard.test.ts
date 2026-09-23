import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { FieldDefinition, FieldDefinitionType } from "../../src/db/schema";
import { buildRecordShape } from "../../src/schemas/record-shape";
import {
  buildRecordDataValidator,
  validateRecordData,
} from "../../src/services/collection-records/validate";

/**
 * A column a connected app fills is read-only to everyone else — and "read-only"
 * has to mean three different things on the same write path, because a record
 * write is not only what it names:
 *
 *  - an EDIT is refused, by name, with the app named too (the person staring at
 *    a greyed cell learns where the value comes from or nowhere);
 *  - an ECHO passes. The record editor PATCHes the whole row on every cell
 *    edit, so refusing an unchanged value would make a collection with one
 *    synced column uneditable;
 *  - an OMISSION preserves. `record-io`'s `replace` mode NULLs every scalar
 *    column absent from `data`, so a writer that never named the column could
 *    otherwise erase the app's values by editing a different cell.
 *
 * The runner itself is let through by an EXPLICIT capability rather than by its
 * actor type: `connector` is also what the CSV import and the approval executor
 * write under, and neither of those may touch these columns.
 */

const SOURCE_ID = "44444444-4444-7444-8444-444444444444";

const field = (
  key: string,
  type: FieldDefinitionType,
  overrides: Partial<FieldDefinition> = {},
): FieldDefinition =>
  ({
    id: `00000000-0000-7000-8000-${key.padEnd(12, "0").slice(0, 12)}`,
    organizationId: "11111111-1111-7111-8111-111111111111",
    teamId: "22222222-2222-7222-8222-222222222222",
    collectionId: "33333333-3333-7333-8333-333333333333",
    key,
    label: key,
    description: null,
    type,
    config: {},
    syncSourceId: null,
    aiExtractionEnabled: true,
    vectorizeInclude: true,
    displayInPanel: true,
    isTitle: false,
    enabled: true,
    displayOrder: 0,
    indexUnusedSince: null,
    indexDroppedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }) satisfies FieldDefinition;

/** An orders collection: one local column, one filled by the app. */
const FIELDS: FieldDefinition[] = [
  field("reference", "text", { isTitle: true }),
  field("revenue", "number", { syncSourceId: SOURCE_ID }),
];

const APPS = new Map([[SOURCE_ID, "Acme"]]);

interface ErrorBody {
  message?: unknown;
  details?: unknown;
}

const isErrorBody = (value: unknown): value is ErrorBody =>
  value !== null && typeof value === "object";

/** The `{ message, details }` envelope `throwHttpError` packs into the throw. */
const caughtError = (
  run: () => unknown,
): { message: string; details: string[] } => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    const body: unknown = JSON.parse(error.message);
    if (!isErrorBody(body)) {
      throw new Error("error body is not an object", { cause: error });
    }
    return {
      message: String(body.message),
      details: Array.isArray(body.details) ? body.details.map(String) : [],
    };
  }
  throw new Error("expected a validation throw");
};

describe("a synced column refuses every writer but its own", () => {
  test("a user editing it is refused, and the message names the app twice", () => {
    const error = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { reference: "ORD-1", revenue: 999 },
        previous: { reference: "ORD-1", revenue: 1200 },
        syncSourceApps: APPS,
      }),
    );
    // Verbatim: the wording IS the contract here — it is the only place a user
    // learns where the value comes from and what the two ways out are.
    expect(error.message).toBe(
      '"revenue" is filled by Acme and cannot be edited here. Change it in Acme, or detach the column from its sync source.',
    );
    expect(error.details).toHaveLength(1);
  });

  test("a create that fills it is refused too — there is no stored value to echo", () => {
    const error = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { reference: "ORD-2", revenue: 10 },
        syncSourceApps: APPS,
      }),
    );
    expect(error.message).toContain('"revenue" is filled by Acme');
  });

  test("the refusal survives an unreadable source row, minus the app's name", () => {
    // Degraded, never absent: a source we could not read must not become a
    // column anyone may write.
    const error = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { revenue: 5 },
      }),
    );
    expect(error.message).toContain("filled by a connected app");
  });

  test("echoing the stored value back is not an edit", () => {
    // What the record editor does on every cell edit: PATCH the whole row.
    const parsed = validateRecordData({
      fieldDefs: FIELDS,
      data: { reference: "ORD-1 bis", revenue: 1200 },
      previous: { reference: "ORD-1", revenue: 1200 },
      syncSourceApps: APPS,
    });
    expect(parsed).toEqual({ reference: "ORD-1 bis", revenue: 1200 });
  });

  test("omitting it cannot clear it — the stored value is pinned back", () => {
    // A full-replace write (`mode: "replace"`) NULLs every scalar column absent
    // from the parsed data. Without the pin, renaming an order would wipe the
    // app's figure.
    const parsed = validateRecordData({
      fieldDefs: FIELDS,
      data: { reference: "ORD-1 bis" },
      previous: { reference: "ORD-1", revenue: 1200 },
      syncSourceApps: APPS,
    });
    expect(parsed).toEqual({ reference: "ORD-1 bis", revenue: 1200 });
  });

  test("the sync runner writes it, with the capability and not with its actor", () => {
    const parsed = validateRecordData({
      fieldDefs: FIELDS,
      data: { reference: "ORD-1", revenue: 1450 },
      previous: { reference: "ORD-1", revenue: 1200 },
      allowSyncedFields: true,
      syncSourceApps: APPS,
    });
    expect(parsed).toEqual({ reference: "ORD-1", revenue: 1450 });
  });

  test("a value the app sends is still validated against its column", () => {
    // The capability lifts the OWNER check, never the type check: a text
    // `revenue` from a sloppy upstream row must still fail like any other.
    const error = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { revenue: "not a number" },
        allowSyncedFields: true,
      }),
    );
    expect(error.message).toContain("revenue (number)");
  });
});

describe("the shape carries the same split", () => {
  test("a synced column is absent for a user and present for the runner", () => {
    expect(Object.keys(buildRecordShape(FIELDS).shape)).toEqual(["reference"]);
    expect(
      Object.keys(buildRecordShape(FIELDS, { allowSyncedFields: true }).shape),
    ).toEqual(["reference", "revenue"]);
  });

  test("the compiled validator is compiled once and guards every row", () => {
    // The batch path: one validator per collection, applied to many rows —
    // the guard must live inside `validate`, not in the compile step.
    const validator = buildRecordDataValidator({
      fieldDefs: FIELDS,
      syncSourceApps: APPS,
    });
    expect(
      validator.validate({ reference: "A" }, { reference: "A", revenue: 7 }),
    ).toEqual({ reference: "A", revenue: 7 });
    expect(() => validator.validate({ revenue: 8 }, { revenue: 7 })).toThrow(
      HTTPException,
    );
  });
});
