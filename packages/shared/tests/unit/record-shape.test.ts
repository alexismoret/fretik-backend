import { describe, expect, it } from "bun:test";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../src/db/schema";
import {
  buildRecordShape,
  coerceRecordValue,
  computeRecordIdentity,
  describeFieldExpectation,
} from "../../src/schemas/record-shape";
import { validateRecordData } from "../../src/services/object-records/validate";

/**
 * Pure (no-DB) guarantees for the record runtime shape + identity helpers.
 * These back every record create/update: the Zod built from a type's field
 * definitions is what rejects malformed writes, and `computeRecordIdentity`
 * is what fills the denormalized label / search columns.
 */

let seq = 0;
const makeField = (
  partial: Partial<FieldDefinition> & {
    key: string;
    type: FieldDefinitionType;
  },
): FieldDefinition => ({
  id: `00000000-0000-7000-0000-${(seq++).toString().padStart(12, "0")}`,
  organizationId: "11111111-1111-1111-1111-111111111111",
  teamId: "22222222-2222-2222-2222-222222222222",
  objectTypeId: "33333333-3333-3333-3333-333333333333",
  label: partial.key,
  description: null,
  config: {} as FieldDefinitionConfig,
  aiExtractionEnabled: true,
  vectorizeInclude: true,
  displayInPanel: true,
  displayInFilters: false,
  isTitle: false,
  enabled: true,
  displayOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...partial,
});

describe("buildRecordShape", () => {
  it("rejects a wrong-typed field (number given to a string field)", () => {
    const shape = buildRecordShape([makeField({ key: "name", type: "text" })]);
    expect(shape.safeParse({ name: 42 }).success).toBe(false);
    expect(shape.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("accepts valid data across mixed types", () => {
    const shape = buildRecordShape([
      makeField({ key: "name", type: "text" }),
      makeField({ key: "count", type: "number" }),
      makeField({ key: "active", type: "boolean" }),
    ]);
    expect(
      shape.safeParse({ name: "Acme", count: 3, active: true }).success,
    ).toBe(true);
  });

  it("allows partial writes (every field is nullish)", () => {
    const shape = buildRecordShape([
      makeField({ key: "name", type: "text" }),
      makeField({ key: "count", type: "number" }),
    ]);
    expect(shape.safeParse({}).success).toBe(true);
    expect(shape.safeParse({ name: "Acme" }).success).toBe(true);
  });

  it("enforces select enum options", () => {
    const shape = buildRecordShape([
      makeField({
        key: "stage",
        type: "select",
        config: {
          options: [
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ],
        },
      }),
    ]);
    expect(shape.safeParse({ stage: "open" }).success).toBe(true);
    expect(shape.safeParse({ stage: "unknown" }).success).toBe(false);
  });

  it("enforces multi_select enum options unless freeform", () => {
    const closed = buildRecordShape([
      makeField({
        key: "tags",
        type: "multi_select",
        config: { options: [{ value: "a", label: "A" }] },
      }),
    ]);
    expect(closed.safeParse({ tags: ["a"] }).success).toBe(true);
    expect(closed.safeParse({ tags: ["b"] }).success).toBe(false);

    const freeform = buildRecordShape([
      makeField({
        key: "tags",
        type: "multi_select",
        config: { options: [{ value: "a", label: "A" }], freeform: true },
      }),
    ]);
    expect(freeform.safeParse({ tags: ["anything"] }).success).toBe(true);
  });

  it("validates concrete email and url types", () => {
    const shape = buildRecordShape([
      makeField({ key: "contact", type: "email" }),
      makeField({ key: "site", type: "url" }),
    ]);
    expect(
      shape.safeParse({ contact: "a@b.com", site: "https://x.io" }).success,
    ).toBe(true);
    expect(shape.safeParse({ contact: "not-an-email" }).success).toBe(false);
    expect(shape.safeParse({ site: "not a url" }).success).toBe(false);
  });

  it("honours number min/max bounds from config", () => {
    const shape = buildRecordShape([
      makeField({ key: "score", type: "number", config: { min: 0, max: 10 } }),
    ]);
    expect(shape.safeParse({ score: 5 }).success).toBe(true);
    expect(shape.safeParse({ score: -1 }).success).toBe(false);
    expect(shape.safeParse({ score: 11 }).success).toBe(false);
  });

  it("validates a money field as { amount, currencyCode }", () => {
    const shape = buildRecordShape([
      makeField({ key: "total", type: "money" }),
    ]);
    expect(
      shape.safeParse({ total: { amount: 1200, currencyCode: "EUR" } }).success,
    ).toBe(true);
    // A bare number is not a money value.
    expect(shape.safeParse({ total: 1200 }).success).toBe(false);
    // Missing currencyCode fails.
    expect(shape.safeParse({ total: { amount: 1200 } }).success).toBe(false);
  });

  it("validates a member field: string single, array when multiple", () => {
    const single = buildRecordShape([
      makeField({ key: "assignee", type: "member" }),
    ]);
    expect(single.safeParse({ assignee: "user_123" }).success).toBe(true);
    expect(single.safeParse({ assignee: ["user_123"] }).success).toBe(false);

    const multi = buildRecordShape([
      makeField({ key: "owners", type: "member", config: { multiple: true } }),
    ]);
    expect(multi.safeParse({ owners: ["user_1", "user_2"] }).success).toBe(
      true,
    );
    expect(multi.safeParse({ owners: "user_1" }).success).toBe(false);
  });

  it("bounds a rating field by config.ratingMax", () => {
    const shape = buildRecordShape([
      makeField({ key: "stars", type: "rating", config: { ratingMax: 5 } }),
    ]);
    expect(shape.safeParse({ stars: 4 }).success).toBe(true);
    expect(shape.safeParse({ stars: 6 }).success).toBe(false);
    expect(shape.safeParse({ stars: -1 }).success).toBe(false);
  });

  it("accepts markdown and phone as strings", () => {
    const shape = buildRecordShape([
      makeField({ key: "notes", type: "markdown" }),
      makeField({ key: "tel", type: "phone" }),
    ]);
    expect(
      shape.safeParse({ notes: "# Title\n- a", tel: "+33123456789" }).success,
    ).toBe(true);
    expect(shape.safeParse({ notes: 42 }).success).toBe(false);
  });

  it("excludes relation fields from the data shape (they live in links)", () => {
    const shape = buildRecordShape([
      makeField({ key: "name", type: "text" }),
      makeField({
        key: "vendor",
        type: "relation",
        config: { targetTypeKey: "company", linkTypeKey: "vendor" },
      }),
    ]);
    // `vendor` is not a key in the shape, so any value for it is stripped and
    // never validated — relations are written via the links graph, not `data`.
    expect(shape.safeParse({ name: "Acme", vendor: "anything" }).success).toBe(
      true,
    );
    expect(Object.keys(shape.shape)).not.toContain("vendor");
  });

  it("skips disabled fields", () => {
    const shape = buildRecordShape([
      makeField({ key: "name", type: "text" }),
      makeField({ key: "legacy", type: "number", enabled: false }),
    ]);
    // A disabled field has no key in the shape; an unknown key is stripped,
    // so even a wrong-typed value for it does not fail the parse.
    expect(shape.safeParse({ name: "Acme", legacy: "junk" }).success).toBe(
      true,
    );
  });
});

describe("coerceRecordValue", () => {
  const fieldOf = (type: FieldDefinitionType, config?: FieldDefinitionConfig) =>
    makeField({ key: "f", type, ...(config ? { config } : {}) });

  it("stringifies a number/boolean for text-like columns (phone keeps its +)", () => {
    // The load-bearing case: a model emits a phone as a JSON number.
    expect(coerceRecordValue(fieldOf("phone"), "+33611223344")).toBe(
      "+33611223344",
    );
    expect(coerceRecordValue(fieldOf("phone"), 33611223344)).toBe(
      "33611223344",
    );
    expect(coerceRecordValue(fieldOf("text"), 42)).toBe("42");
    expect(coerceRecordValue(fieldOf("markdown"), true)).toBe("true");
  });

  it("parses a numeric string for number/rating columns", () => {
    expect(coerceRecordValue(fieldOf("number"), "5000")).toBe(5000);
    expect(coerceRecordValue(fieldOf("number"), " 12.5 ")).toBe(12.5);
    expect(coerceRecordValue(fieldOf("rating"), "4")).toBe(4);
    // Spaces and a leading currency symbol are stripped.
    expect(coerceRecordValue(fieldOf("number"), "€1 500")).toBe(1500);
    // Non-numeric string is left for Zod to reject (no silent 0).
    expect(coerceRecordValue(fieldOf("number"), "abc")).toBe("abc");
    expect(coerceRecordValue(fieldOf("number"), "")).toBe("");
  });

  it("maps boolean yes/no/y/n too", () => {
    expect(coerceRecordValue(fieldOf("boolean"), "yes")).toBe(true);
    expect(coerceRecordValue(fieldOf("boolean"), "No")).toBe(false);
    expect(coerceRecordValue(fieldOf("boolean"), "Y")).toBe(true);
  });

  it("maps boolean string/number representations (z.coerce footgun avoided)", () => {
    expect(coerceRecordValue(fieldOf("boolean"), "true")).toBe(true);
    // The exact case z.coerce.boolean() gets wrong:
    expect(coerceRecordValue(fieldOf("boolean"), "false")).toBe(false);
    expect(coerceRecordValue(fieldOf("boolean"), "1")).toBe(true);
    expect(coerceRecordValue(fieldOf("boolean"), 0)).toBe(false);
    expect(coerceRecordValue(fieldOf("boolean"), "maybe")).toBe("maybe");
  });

  it("unwraps a single-element array for a scalar field (weak-model array-wrap)", () => {
    // The reported case: the model wrapped every scalar in `["…"]`.
    expect(coerceRecordValue(fieldOf("text"), ["Northwind Trading"])).toBe(
      "Northwind Trading",
    );
    expect(coerceRecordValue(fieldOf("phone"), ["+33611223344"])).toBe(
      "+33611223344",
    );
    expect(coerceRecordValue(fieldOf("number"), ["320"])).toBe(320);
    // A single-member field unwraps too.
    expect(coerceRecordValue(fieldOf("member"), ["user_1"])).toBe("user_1");
    // multi_select keeps its list (a real list field).
    expect(coerceRecordValue(fieldOf("multi_select"), ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("wraps a bare scalar into a list for multi_select", () => {
    expect(coerceRecordValue(fieldOf("multi_select"), "tag")).toEqual(["tag"]);
    expect(coerceRecordValue(fieldOf("multi_select"), 7)).toEqual(["7"]);
    expect(coerceRecordValue(fieldOf("multi_select"), ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });

  it("wraps a bare member id into a list for a multi-member field", () => {
    const multi = { multiple: true } as FieldDefinitionConfig;
    // A multi-member field is a list: a bare id becomes a one-element list
    // (mirrors multi_select) so a weak model's scalar doesn't hard-fail.
    expect(coerceRecordValue(fieldOf("member", multi), "user_1")).toEqual([
      "user_1",
    ]);
    expect(
      coerceRecordValue(fieldOf("member", multi), ["user_1", "user_2"]),
    ).toEqual(["user_1", "user_2"]);
    // A single-member field keeps the bare id (one-element array already
    // unwrapped at the top).
    expect(coerceRecordValue(fieldOf("member"), "user_1")).toBe("user_1");
    expect(coerceRecordValue(fieldOf("member"), ["user_1"])).toBe("user_1");
  });

  it("reduces a date field to YYYY-MM-DD (a datetime keeps only its date)", () => {
    expect(coerceRecordValue(fieldOf("date"), " 2025-01-15 ")).toBe(
      "2025-01-15",
    );
    // A datetime (incl. a zone offset) for a date field → its calendar day.
    expect(
      coerceRecordValue(fieldOf("date"), "2026-06-27T19:31:00+02:00"),
    ).toBe("2026-06-27");
  });

  it("normalizes a datetime field to canonical ISO 8601 UTC", () => {
    // Date only → midnight UTC (the reported 'Expected ISO 8601' case).
    expect(coerceRecordValue(fieldOf("datetime"), "2026-06-27")).toBe(
      "2026-06-27T00:00:00.000Z",
    );
    // A zone offset is converted to Z (the second reported failure).
    expect(
      coerceRecordValue(fieldOf("datetime"), "2026-06-27T19:31:00+02:00"),
    ).toBe("2026-06-27T17:31:00.000Z");
    // Already canonical → unchanged.
    expect(
      coerceRecordValue(fieldOf("datetime"), "2025-01-15T10:30:00.000Z"),
    ).toBe("2025-01-15T10:30:00.000Z");
  });

  it("maps a select label/casing onto its canonical option value", () => {
    const cfg = {
      options: [
        { value: "gold", label: "Gold" },
        { value: "silver", label: "Silver" },
      ],
    } as FieldDefinitionConfig;
    expect(coerceRecordValue(fieldOf("select", cfg), "Gold")).toBe("gold");
    expect(coerceRecordValue(fieldOf("select", cfg), "GOLD")).toBe("gold");
    expect(coerceRecordValue(fieldOf("select", cfg), "gold")).toBe("gold");
    // multi_select maps each member; a bare scalar becomes a one-element list.
    expect(coerceRecordValue(fieldOf("multi_select", cfg), "Silver")).toEqual([
      "silver",
    ]);
    // An unknown option is left as-is for Zod's enum to reject.
    expect(coerceRecordValue(fieldOf("select", cfg), "Bronze")).toBe("Bronze");
  });

  it("prepends https:// to a scheme-less url, leaves a number for Zod", () => {
    expect(coerceRecordValue(fieldOf("url"), "example.com")).toBe(
      "https://example.com",
    );
    expect(coerceRecordValue(fieldOf("url"), "http://x.io")).toBe(
      "http://x.io",
    );
    // A number isn't a URL — semantic mismatch, left for Zod.
    expect(coerceRecordValue(fieldOf("email"), 12345)).toBe(12345);
    expect(coerceRecordValue(fieldOf("url"), 12345)).toBe(12345);
  });

  it("parses a money string into { amount, currencyCode }", () => {
    expect(coerceRecordValue(fieldOf("money"), "1500 EUR")).toEqual({
      amount: 1500,
      currencyCode: "EUR",
    });
    expect(coerceRecordValue(fieldOf("money"), "USD 99.90")).toEqual({
      amount: 99.9,
      currencyCode: "USD",
    });
    // No currency in the string → fall back to the field's default.
    expect(
      coerceRecordValue(
        fieldOf("money", { defaultCurrencyCode: "GBP" }),
        "2000",
      ),
    ).toEqual({ amount: 2000, currencyCode: "GBP" });
    // No currency and no default → unparseable, left for Zod to reject.
    expect(coerceRecordValue(fieldOf("money"), "2000")).toBe("2000");
    // The structured object form (SDK/API) passes through untouched.
    const money = { amount: 1200, currencyCode: "EUR" };
    expect(coerceRecordValue(fieldOf("money"), money)).toBe(money);
  });

  it("leaves null/undefined and email/url numbers untouched", () => {
    expect(coerceRecordValue(fieldOf("phone"), null)).toBe(null);
    expect(coerceRecordValue(fieldOf("number"), undefined)).toBe(undefined);
  });

  it("coercion makes a wrong-primitive write pass while the real shape still validates", () => {
    const shape = buildRecordShape([makeField({ key: "tel", type: "phone" })]);
    // Raw model output: number — would fail without coercion.
    expect(shape.safeParse({ tel: 33611223344 }).success).toBe(false);
    // After coercion it is a string and passes.
    const coerced = coerceRecordValue(
      makeField({ key: "tel", type: "phone" }),
      33611223344,
    );
    expect(shape.safeParse({ tel: coerced }).success).toBe(true);
  });

  it("a date-only or offset datetime passes the shape after coercion (the reported bug)", () => {
    const def = makeField({ key: "added_on", type: "datetime" });
    const shape = buildRecordShape([def]);
    // Both raw forms the agent sent originally were rejected outright.
    expect(shape.safeParse({ added_on: "2026-06-27" }).success).toBe(false);
    // Coerced, both validate.
    for (const raw of ["2026-06-27", "2026-06-27T19:31:00+02:00"]) {
      expect(
        shape.safeParse({ added_on: coerceRecordValue(def, raw) }).success,
      ).toBe(true);
    }
    // The loosened regex now also accepts a raw offset directly.
    expect(
      shape.safeParse({ added_on: "2026-06-27T19:31:00+02:00" }).success,
    ).toBe(true);
  });
});

describe("computeRecordIdentity", () => {
  const fields = [
    makeField({ key: "name", type: "text", isTitle: true }),
    makeField({ key: "city", type: "text" }),
    makeField({ key: "count", type: "number" }),
  ];

  it("derives the label from the isTitle field", () => {
    const identity = computeRecordIdentity({
      fieldDefs: fields,
      data: { name: "Acme Corp", city: "Paris", count: 3 },
    });
    expect(identity.label).toBe("Acme Corp");
  });

  it("uses labelOverride when given", () => {
    const identity = computeRecordIdentity({
      fieldDefs: fields,
      data: { name: "Acme Corp" },
      labelOverride: "invoice-2025.pdf",
    });
    expect(identity.label).toBe("invoice-2025.pdf");
  });

  it("normalizes the label", () => {
    const identity = computeRecordIdentity({
      fieldDefs: fields,
      data: { name: "Globex Industries Ltd" },
    });
    // normalizeEntityName lowercases and strips the legal suffix (Ltd).
    expect(identity.normalizedLabel).toBe("globex industries");
  });

  it("builds searchText from the label plus text/select values", () => {
    const identity = computeRecordIdentity({
      fieldDefs: fields,
      data: { name: "Acme Corp", city: "Paris", count: 3 },
    });
    expect(identity.searchText).toContain("Acme Corp");
    expect(identity.searchText).toContain("Paris");
    // Numbers are not text-like, so they do not land in searchText.
    expect(identity.searchText).not.toContain("3");
  });

  it("returns an empty label when no title field and no override", () => {
    const identity = computeRecordIdentity({
      fieldDefs: [makeField({ key: "city", type: "text" })],
      data: { city: "Paris" },
    });
    expect(identity.label).toBe("");
    expect(identity.normalizedLabel).toBe("");
    expect(identity.searchText).toBe("Paris");
  });
});

describe("describeFieldExpectation", () => {
  it("lists the valid option values for a select (so the model copies them)", () => {
    const line = describeFieldExpectation(
      makeField({
        key: "tier",
        type: "select",
        config: {
          options: [
            { value: "gold", label: "Gold" },
            { value: "silver", label: "Silver" },
          ],
        },
      }),
    );
    expect(line).toBe("tier (select): one of [gold, silver]");
  });

  it("frames multi_select as a list of the option values", () => {
    const line = describeFieldExpectation(
      makeField({
        key: "regions",
        type: "multi_select",
        config: { options: [{ value: "emea", label: "EMEA" }] },
      }),
    );
    expect(line).toBe("regions (multi_select): a list from [emea]");
  });

  it("gives a format example for date / number / money", () => {
    expect(
      describeFieldExpectation(makeField({ key: "due", type: "date" })),
    ).toContain("YYYY-MM-DD");
    expect(
      describeFieldExpectation(
        makeField({
          key: "amount",
          type: "number",
          config: { min: 0, max: 100 },
        }),
      ),
    ).toBe('amount (number): a quoted number between 0 and 100, e.g. "1500"');
    expect(
      describeFieldExpectation(makeField({ key: "total", type: "money" })),
    ).toContain("1500 EUR");
  });

  it("distinguishes single vs multi member", () => {
    expect(
      describeFieldExpectation(makeField({ key: "owner", type: "member" })),
    ).toBe("owner (member): a user id");
    expect(
      describeFieldExpectation(
        makeField({
          key: "owners",
          type: "member",
          config: { multiple: true },
        }),
      ),
    ).toBe("owners (member): a list of user ids");
  });
});

describe("validateRecordData — errors that teach", () => {
  const teachingMessage = (
    fieldDefs: FieldDefinition[],
    data: Record<string, unknown>,
  ): string => {
    try {
      validateRecordData({ fieldDefs, data });
      throw new Error("expected validateRecordData to throw");
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // throwHttpError wraps the ApiError as a JSON string in `.message`.
      const parsed: unknown = JSON.parse(err.message);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof parsed.message === "string"
      ) {
        return parsed.message;
      }
      throw new Error("error message was not the expected envelope", {
        cause: err,
      });
    }
  };

  it("teaches the valid options when a select value is wrong", () => {
    const message = teachingMessage(
      [
        makeField({
          key: "tier",
          type: "select",
          config: {
            options: [
              { value: "gold", label: "Gold" },
              { value: "silver", label: "Silver" },
            ],
          },
        }),
      ],
      { tier: "platinum" },
    );
    expect(message).toContain("tier (select): one of [gold, silver]");
  });

  it("teaches the date format on a malformed date", () => {
    const message = teachingMessage([makeField({ key: "due", type: "date" })], {
      due: "not-a-date",
    });
    expect(message).toContain("YYYY-MM-DD");
  });

  it("teaches when the model invents a field key (not silently dropped)", () => {
    // The model copied SQL columns `annual_value_amount`/`_currency` instead of
    // the field key `annual_value`. z.object would strip them silently; strict
    // validation must name them + list the valid keys so the model corrects.
    const message = teachingMessage(
      [makeField({ key: "annual_value", type: "money" })],
      { annual_value_amount: 75000, annual_value_currency: "EUR" },
    );
    expect(message).toContain("Unknown field(s)");
    expect(message).toContain("annual_value_amount");
    expect(message).toContain("annual_value");
  });

  it("tolerates extra keys on the lenient document-mirror path (strict:false)", () => {
    // The mirror passes best-effort extracted keys; unknown ones are stripped,
    // not rejected. No throw.
    const parsed = validateRecordData({
      fieldDefs: [makeField({ key: "name", type: "text" })],
      data: { name: "Acme", stray_extracted_key: "x" },
      strict: false,
    });
    expect(parsed).toEqual({ name: "Acme" });
  });
});
