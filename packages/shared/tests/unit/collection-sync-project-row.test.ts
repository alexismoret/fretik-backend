import { describe, expect, it } from "bun:test";
import type { FieldDefinition } from "../../src/db/schema";
import {
  hashProjection,
  inferFieldTypeFromParamSpec,
  inferFieldTypeFromSamples,
  projectRow,
  readPath,
} from "../../src/services/collection-sync/project-row";

/**
 * Projection and its hash — the two halves of "is this row worth writing".
 *
 * The hash is the load-bearing one. An hourly sync of 10 000 rows where nothing
 * moved must write NOTHING, because every write costs a `domain_events` row, a
 * record-card re-embedding and a workflow-trigger candidate. Two properties make
 * that true and are asserted here:
 *
 *  1. the hash is over the COERCED values, so an upstream that answers `"42"`
 *     today and `42` tomorrow is not a change;
 *  2. the hash is over a CANONICAL form, so a provider reordering its response
 *     object is not a change either.
 *
 * Break either and the sync still works — it just rewrites the whole collection
 * every hour, which is the failure this feature cannot afford and which no
 * functional test would notice.
 */

/**
 * A field definition, every column present and none of them asserted.
 * `$inferSelect` is the type (never a hand-written `FakeRow`): a fixture that
 * lies about the schema has already broken a renderer here once.
 */
const field = (
  key: string,
  type: FieldDefinition["type"],
  config: FieldDefinition["config"] = {},
): FieldDefinition => {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id: `f-${key}`,
    organizationId: "org",
    teamId: "team",
    collectionId: "coll",
    key,
    label: key,
    description: null,
    type,
    config,
    syncSourceId: null,
    aiExtractionEnabled: false,
    vectorizeInclude: false,
    displayInPanel: true,
    isTitle: false,
    enabled: true,
    displayOrder: 0,
    indexUnusedSince: null,
    indexDroppedAt: null,
    createdAt: now,
    updatedAt: now,
  };
};

describe("readPath", () => {
  it("walks nested objects and array indexes", () => {
    const row = { a: { b: [{ c: "x" }] } };
    expect(readPath(row, "a.b[0].c")).toBe("x");
  });

  it("stops at the first missing step instead of throwing", () => {
    expect(readPath({ a: null }, "a.b.c")).toBeUndefined();
    expect(readPath({}, "nope")).toBeUndefined();
  });
});

describe("projectRow — only what the source owns, typed for its column", () => {
  const fields = [
    field("ref", "text"),
    field("amount", "number"),
    field("shipped_on", "date"),
    field("active", "boolean"),
  ];
  const mapping = [
    { path: "id", fieldKey: "ref" },
    { path: "totals.gross", fieldKey: "amount" },
    { path: "dates.shipped", fieldKey: "shipped_on" },
    { path: "flags.active", fieldKey: "active" },
  ];

  it("coerces each value to the shape its column expects", () => {
    const { data } = projectRow({
      row: {
        id: 4821,
        totals: { gross: "1 500" },
        dates: { shipped: "2026-03-04T08:00:00Z" },
        flags: { active: "true" },
      },
      mapping,
      fields,
    });
    // A number in a text column is its text form; a string in a numeric one is
    // parsed; a date-time lands on the calendar day of a `hasTime: false` field.
    expect(data["ref"]).toBe("4821");
    expect(data["amount"]).toBe(1500);
    expect(data["shipped_on"]).toBe("2026-03-04");
    expect(data["active"]).toBe(true);
  });

  it("clears a column whose upstream value has gone", () => {
    const { data } = projectRow({ row: { id: "A" }, mapping, fields });
    // `null`, not absent: a merge write treats an absent key as "leave it", and
    // a figure that disappeared upstream must not outlive the fact it described.
    expect(data["amount"]).toBeNull();
    expect("amount" in data).toBe(true);
  });

  it("never writes a column the source does not own", () => {
    const { data } = projectRow({
      row: { id: "A", secret: "s" },
      mapping: [...mapping, { path: "secret", fieldKey: "notes" }],
      fields,
    });
    expect("notes" in data).toBe(false);
  });

  it("refuses a derived column even when it is mapped", () => {
    const { data } = projectRow({
      row: { id: "A", total: 10 },
      mapping: [{ path: "total", fieldKey: "computed" }],
      fields: [...fields, field("computed", "formula")],
    });
    // A formula is a `GENERATED … STORED` column Postgres physically refuses a
    // value for — writing it would fail the whole chunk, not just the column.
    expect(data).toEqual({});
  });

  it("puts an unrepresentable value in a scalar column at null, not in errors", () => {
    const { data } = projectRow({
      row: { totals: { gross: { nested: true } } },
      mapping: [{ path: "totals.gross", fieldKey: "amount" }],
      fields,
    });
    // One unmappable column must not cost a row its other forty.
    expect(data["amount"]).toBeNull();
  });

  it("renders an object into a text column rather than dropping it", () => {
    const { data } = projectRow({
      row: { blob: { a: 1 } },
      mapping: [{ path: "blob", fieldKey: "ref" }],
      fields,
    });
    expect(data["ref"]).toBe('{"a":1}');
  });

  it("reads an epoch number into a date column", () => {
    const seconds = projectRow({
      row: { dates: { shipped: 1_772_000_000 } },
      mapping,
      fields,
    });
    const millis = projectRow({
      row: { dates: { shipped: 1_772_000_000_000 } },
      mapping,
      fields,
    });
    // The magnitude is the discriminator: 1e11 seconds is the year 5138.
    expect(seconds.data["shipped_on"]).toBe(millis.data["shipped_on"]);
    expect(seconds.data["shipped_on"]).toBe("2026-02-25");
  });
});

describe("the hash — stable on noise, different on a real change", () => {
  const fields = [field("ref", "text"), field("amount", "number")];
  const mapping = [
    { path: "id", fieldKey: "ref" },
    { path: "gross", fieldKey: "amount" },
  ];

  it("is unchanged when the same row is projected twice", () => {
    const a = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    const b = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    expect(a.hash).toBe(b.hash);
  });

  it("is unchanged when the provider reorders its keys", () => {
    const a = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    const b = projectRow({ row: { gross: 10, id: "A" }, mapping, fields });
    expect(a.hash).toBe(b.hash);
  });

  it("is unchanged when the provider changes a value's JSON type", () => {
    // `"10"` and `10` both coerce to 10 for a number column: nothing a person
    // can see has changed, so nothing must be rewritten.
    const a = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    const b = projectRow({ row: { id: "A", gross: "10" }, mapping, fields });
    expect(a.hash).toBe(b.hash);
  });

  it("is unchanged when an unmapped part of the row changes", () => {
    const a = projectRow({
      row: { id: "A", gross: 10, x: 1 },
      mapping,
      fields,
    });
    const b = projectRow({
      row: { id: "A", gross: 10, x: 2 },
      mapping,
      fields,
    });
    expect(a.hash).toBe(b.hash);
  });

  it("differs when a mapped value really changes", () => {
    const a = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    const b = projectRow({ row: { id: "A", gross: 11 }, mapping, fields });
    expect(a.hash).not.toBe(b.hash);
  });

  it("differs when a value is cleared", () => {
    const a = projectRow({ row: { id: "A", gross: 10 }, mapping, fields });
    const b = projectRow({ row: { id: "A" }, mapping, fields });
    expect(a.hash).not.toBe(b.hash);
  });

  it("fits the column that stores it", () => {
    // `record_sync_state.content_hash` is varchar(64).
    expect(hashProjection({ a: 1 })).toHaveLength(64);
  });
});

describe("inferFieldTypeFromParamSpec — the plan's §3.6 table", () => {
  it("maps each declared scalar to its column type", () => {
    expect(inferFieldTypeFromParamSpec({ type: "string" })?.type).toBe("text");
    expect(inferFieldTypeFromParamSpec({ type: "integer" })?.type).toBe(
      "number",
    );
    expect(inferFieldTypeFromParamSpec({ type: "number" })?.type).toBe(
      "number",
    );
    expect(inferFieldTypeFromParamSpec({ type: "boolean" })?.type).toBe(
      "boolean",
    );
    expect(inferFieldTypeFromParamSpec({ type: "email" })?.type).toBe("email");
  });

  it("splits date from datetime with hasTime, not with a second type", () => {
    expect(inferFieldTypeFromParamSpec({ type: "date" })).toEqual({
      type: "date",
      config: { hasTime: false },
    });
    expect(inferFieldTypeFromParamSpec({ type: "datetime" })).toEqual({
      type: "date",
      config: { hasTime: true },
    });
  });

  it("carries an enum's values into the select's options", () => {
    const inferred = inferFieldTypeFromParamSpec({
      type: "enum",
      values: ["draft", "sent"],
    });
    expect(inferred?.type).toBe("select");
    expect(inferred?.config).toEqual({
      options: [
        { value: "draft", label: "draft" },
        { value: "sent", label: "sent" },
      ],
    });
  });

  it("proposes url/phone from the name, and only over text", () => {
    expect(
      inferFieldTypeFromParamSpec({ type: "string" }, "website_url")?.type,
    ).toBe("url");
    expect(
      inferFieldTypeFromParamSpec({ type: "string" }, "mobile")?.type,
    ).toBe("phone");
    // The hint never overrides a declared type.
    expect(
      inferFieldTypeFromParamSpec({ type: "integer" }, "phone")?.type,
    ).toBe("number");
  });

  it("refuses a container rather than proposing a jsonb column", () => {
    expect(
      inferFieldTypeFromParamSpec({ type: "object", fields: {} }),
    ).toBeUndefined();
    expect(
      inferFieldTypeFromParamSpec({
        type: "array",
        items: { type: "object", fields: {} },
      }),
    ).toBeUndefined();
  });

  it("maps a list of strings to a freeform multi_select", () => {
    expect(
      inferFieldTypeFromParamSpec({ type: "array", items: { type: "string" } }),
    ).toEqual({ type: "multi_select", config: { freeform: true } });
  });
});

describe("inferFieldTypeFromSamples — timid on purpose", () => {
  it("ignores nulls rather than letting them decide", () => {
    // A column empty in row one and numeric in row two is numeric.
    expect(inferFieldTypeFromSamples([null, undefined, "", 3]).type).toBe(
      "number",
    );
  });

  it("falls back to text the moment the samples disagree", () => {
    // A wrong column TYPE is a row that stops landing — worse than a wide one.
    expect(inferFieldTypeFromSamples([1, "abc"]).type).toBe("text");
  });

  it("claims nothing from an entirely empty column", () => {
    expect(inferFieldTypeFromSamples([null, null]).type).toBe("text");
  });

  it("recognises the two date shapes, an email and a url", () => {
    expect(inferFieldTypeFromSamples(["2026-01-02"])).toEqual({
      type: "date",
      config: { hasTime: false },
    });
    expect(inferFieldTypeFromSamples(["2026-01-02T03:04:05Z"])).toEqual({
      type: "date",
      config: { hasTime: true },
    });
    expect(inferFieldTypeFromSamples(["a@b.co"]).type).toBe("email");
    expect(inferFieldTypeFromSamples(["https://x.dev/a"]).type).toBe("url");
  });

  it("does not mistake a mixed date column for a date", () => {
    expect(inferFieldTypeFromSamples(["2026-01-02", "yesterday"]).type).toBe(
      "text",
    );
  });
});
