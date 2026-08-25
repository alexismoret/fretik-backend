import { describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import type { FieldDefinition, FieldDefinitionType } from "../../src/db/schema";
import type { FieldDefinitionConfig } from "../../src/db/schema/field-types";
import {
  buildRecordDataValidator,
  validateRecordData,
} from "../../src/services/collection-records/validate";

/**
 * The validator was hoisted out of the bulk services' row loop
 * (`buildRecordDataValidator` compiles the Zod shape once per type instead of
 * once per row). Two things had to survive that move, and neither shows up in a
 * typecheck:
 *
 *  - the PARSED OUTPUT, including the coercions a weak model relies on;
 *  - the ERROR STRINGS, verbatim. They are read by the agent, which corrects
 *    itself from their wording — "errors that teach" is a load-bearing
 *    contract, not a log message. A test that asserts "it throws" would let a
 *    reworded message through.
 *
 * `validateRecordData` (single-row) is now a wrapper over the compiled form, so
 * asserting on it covers both entry points at once; the last block checks the
 * two agree.
 */

const field = (
  key: string,
  type: FieldDefinitionType,
  config: FieldDefinitionConfig = {},
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
    config,
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

const FIELDS: FieldDefinition[] = [
  field("name", "text", {}, { isTitle: true }),
  field("headcount", "number"),
  field("active", "boolean"),
  field("tier", "select", {
    options: [
      { value: "gold", label: "Gold" },
      { value: "silver", label: "Silver" },
    ],
  }),
  field("phone", "phone"),
  field("signed_on", "date"),
];

/** The `{ message, details }` envelope `throwHttpError` packs into the throw. */
const caughtError = (
  run: () => unknown,
): { message: string; details: string[] } => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof HTTPException)) throw error;
    const parsed: unknown = JSON.parse(error.message);
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("error body is not an object", { cause: error });
    }
    const body = parsed as { message?: unknown; details?: unknown };
    return {
      message: String(body.message),
      details: Array.isArray(body.details) ? body.details.map(String) : [],
    };
  }
  throw new Error("expected a validation throw");
};

describe("validateRecordData — accepted data", () => {
  test("passes a clean row through", () => {
    expect(
      validateRecordData({
        fieldDefs: FIELDS,
        data: { name: "ACME", headcount: 12, active: true, tier: "gold" },
      }),
    ).toMatchObject({
      name: "ACME",
      headcount: 12,
      active: true,
      tier: "gold",
    });
  });

  test("keeps the coercions a weak model depends on", () => {
    // These are the representational slips `coerceRecordValue` exists to
    // absorb — a phone sent as a number, a boolean sent as "true".
    const parsed = validateRecordData({
      fieldDefs: FIELDS,
      data: { name: "ACME", phone: 33612345678, active: "true" },
    });
    expect(parsed["phone"]).toBe("33612345678");
    expect(parsed["active"]).toBe(true);
  });

  test("a partial row is valid — every field is nullish", () => {
    expect(
      validateRecordData({ fieldDefs: FIELDS, data: { name: "ACME" } }),
    ).toMatchObject({ name: "ACME" });
  });

  test("lenient mode tolerates keys that are not fields", () => {
    expect(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { name: "ACME", not_a_field: 1 },
        strict: false,
      }),
    ).not.toThrow();
  });
});

describe("validateRecordData — the error strings the agent reads", () => {
  test("an unknown key names it AND lists the valid keys", () => {
    const { message, details } = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { name: "ACME", annual_value_amount: 10 },
      }),
    );
    expect(details).toEqual([
      "Unknown field(s): annual_value_amount — not keys of this type. Use a field key from: name, headcount, active, tier, phone, signed_on",
    ]);
    expect(message).toBe(
      "Some values don't match their field — fix and retry: Unknown field(s): annual_value_amount — not keys of this type. Use a field key from: name, headcount, active, tier, phone, signed_on",
    );
  });

  test("the valid-key list stops at 12 and says so", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      field(`f${String(i)}`, "text"),
    );
    const { details } = caughtError(() =>
      validateRecordData({ fieldDefs: many, data: { nope: 1 } }),
    );
    expect(details[0]).toBe(
      "Unknown field(s): nope — not keys of this type. Use a field key from: f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, …",
    );
  });

  test("a bad value is explained per field, not as a Zod dump", () => {
    const { details } = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { name: "ACME", headcount: "not a number" },
      }),
    );
    expect(details).toHaveLength(1);
    expect(details[0]).toContain("headcount");
    expect(details[0]).not.toContain("ZodError");
  });

  test("a select rejects an option that is not in its list", () => {
    const { details } = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { name: "ACME", tier: "platinum" },
      }),
    );
    expect(details[0]).toContain("tier");
  });

  test("repeated identical reasons are deduped into one line", () => {
    const { details } = caughtError(() =>
      validateRecordData({
        fieldDefs: FIELDS,
        data: { nope_a: 1, nope_b: 2 },
      }),
    );
    // Both unknown keys ride ONE line, not one line each.
    expect(details).toHaveLength(1);
    expect(details[0]).toContain("nope_a, nope_b");
  });
});

describe("buildRecordDataValidator — the compiled form matches the one-shot", () => {
  const rows = [
    { name: "ACME", headcount: 3 },
    { name: "Globex", tier: "silver" },
    { name: "Initech", headcount: "boom" },
    { unknown_key: 1 },
    { name: "Umbrella", phone: 33600000000, active: "true" },
  ];

  test("same outcome, row for row, including the error text", () => {
    const validator = buildRecordDataValidator({ fieldDefs: FIELDS });
    for (const row of rows) {
      let compiled: unknown;
      let oneShot: unknown;
      try {
        compiled = validator.validate(row);
      } catch {
        compiled = caughtError(() => validator.validate(row));
      }
      try {
        oneShot = validateRecordData({ fieldDefs: FIELDS, data: row });
      } catch {
        oneShot = caughtError(() =>
          validateRecordData({ fieldDefs: FIELDS, data: row }),
        );
      }
      expect(compiled).toEqual(oneShot);
    }
  });

  test("reuse does not leak state between rows", () => {
    // The shape and the key index are shared across calls now — a row that
    // fails must not poison the next one.
    const validator = buildRecordDataValidator({ fieldDefs: FIELDS });
    expect(() => validator.validate({ headcount: "boom" })).toThrow();
    expect(validator.validate({ name: "ACME" })).toMatchObject({
      name: "ACME",
    });
    expect(() => validator.validate({ nope: 1 })).toThrow();
    expect(validator.validate({ name: "Globex" })).toMatchObject({
      name: "Globex",
    });
  });

  test("exposes the key index its callers already needed", () => {
    const validator = buildRecordDataValidator({ fieldDefs: FIELDS });
    expect(validator.byKey.get("tier")?.type).toBe("select");
    expect(validator.byKey.has("not_a_field")).toBe(false);
  });
});
