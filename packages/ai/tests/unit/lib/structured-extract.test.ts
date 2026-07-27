import { describe, expect, test } from "bun:test";
import {
  buildExtractionSchema,
  EXTRACT_SECTION_PAGES,
  parseExtractionEnvelope,
  planSections,
} from "../../../src/lib/structured-extract";

/** Assert a schema was built and return the record's property map. */
const recordProps = (
  fields: Parameters<typeof buildExtractionSchema>[0],
  shape: Parameters<typeof buildExtractionSchema>[1] = "records",
): Record<string, Record<string, unknown>> => {
  const prepared = buildExtractionSchema(fields, shape);
  if ("error" in prepared) throw new Error(prepared.error);
  const wrapped = prepared.wrapped as Record<string, unknown>;
  const props = wrapped["properties"] as Record<string, unknown>;
  const record =
    shape === "records"
      ? ((props["records"] as Record<string, unknown>)["items"] as Record<
          string,
          unknown
        >)
      : (props["record"] as Record<string, unknown>);
  return record["properties"] as Record<string, Record<string, unknown>>;
};

describe("buildExtractionSchema", () => {
  test("string shorthand → a nullable string field", () => {
    const props = recordProps(["label"]);
    expect(props["label"]).toEqual({ type: ["string", "null"] });
  });

  test("object field maps type and keeps the description", () => {
    const props = recordProps([
      { name: "amount", type: "number", description: "line total" },
    ]);
    expect(props["amount"]).toEqual({
      type: ["number", "null"],
      description: "line total",
    });
  });

  test("date maps to a nullable string with an ISO hint", () => {
    const props = recordProps([{ name: "issued", type: "date" }]);
    expect(props["issued"]?.["type"]).toEqual(["string", "null"]);
    expect(String(props["issued"]?.["description"])).toContain("ISO 8601");
  });

  test("every scalar type admits null so absent values are not invented", () => {
    const props = recordProps([
      { name: "a", type: "integer" },
      { name: "b", type: "boolean" },
    ]);
    expect(props["a"]?.["type"]).toEqual(["integer", "null"]);
    expect(props["b"]?.["type"]).toEqual(["boolean", "null"]);
  });

  test("records shape wraps in a records array; record shape wraps one object", () => {
    const asRecords = buildExtractionSchema(["x"], "records");
    if ("error" in asRecords) throw new Error(asRecords.error);
    expect(asRecords.promptSchema).toContain('"records"');
    const asRecord = buildExtractionSchema(["x"], "record");
    if ("error" in asRecord) throw new Error(asRecord.error);
    expect(asRecord.promptSchema).toContain('"record"');
  });

  test("rejects an empty field list", () => {
    expect(buildExtractionSchema([], "records")).toHaveProperty("error");
  });

  test("rejects an over-long field list", () => {
    const many = Array.from({ length: 61 }, (_, i) => `f${i}`);
    expect(buildExtractionSchema(many, "records")).toHaveProperty("error");
  });

  test("rejects an unknown field type", () => {
    expect(
      buildExtractionSchema([{ name: "a", type: "money" as never }], "records"),
    ).toHaveProperty("error");
  });

  test("tolerates a repeated field name (keeps the first)", () => {
    const props = recordProps(["dup", "dup"]);
    expect(Object.keys(props)).toEqual(["dup"]);
  });

  test("records shape requires the server-side count field, record shape does not", () => {
    const asRecords = buildExtractionSchema(["x"], "records");
    if ("error" in asRecords) throw new Error(asRecords.error);
    const wrapped = asRecords.wrapped as Record<string, unknown>;
    expect(wrapped["required"]).toEqual(["total_matching_records", "records"]);
    const props = wrapped["properties"] as Record<string, unknown>;
    const count = props["total_matching_records"] as Record<string, unknown>;
    expect(count["type"]).toBe("integer");

    const asRecord = buildExtractionSchema(["x"], "record");
    if ("error" in asRecord) throw new Error(asRecord.error);
    expect(asRecord.promptSchema).not.toContain("total_matching_records");
  });

  test("string-length ceiling lives in the validator only, never on the wire", () => {
    const prepared = buildExtractionSchema(["label"], "records");
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.promptSchema).not.toContain("maxLength");
    // A leaked chain-of-thought inside a value drops the record…
    expect(prepared.validateRecord({ label: "x".repeat(1001) })).toBe(false);
    // …while a normal long-ish value passes.
    expect(prepared.validateRecord({ label: "x".repeat(900) })).toBe(true);
  });
});

describe("output parsing & validation", () => {
  test("free-form response parses leniently; per-record validator coerces", () => {
    const prepared = buildExtractionSchema(
      [{ name: "qty", type: "number" }],
      "records",
    );
    if ("error" in prepared) throw new Error(prepared.error);
    // Prose + fenced JSON with a stray string number — parsed, not rejected.
    const envelope = parseExtractionEnvelope(
      'Here is the result:\n```json\n{"total_matching_records":1,"records":[{"qty":"12.5"}]}\n```\nDone.',
    );
    expect(envelope).toEqual({
      records: [{ qty: "12.5" }],
      reportedTotal: 1,
    });
    // The per-record validator coerces "12.5" → 12.5 in place.
    const row: Record<string, unknown> = { qty: "12.5" };
    expect(prepared.validateRecord(row)).toBe(true);
    expect(row["qty"]).toBe(12.5);
  });

  test("per-record validator strips invented keys", () => {
    const prepared = buildExtractionSchema(["label"], "records");
    if ("error" in prepared) throw new Error(prepared.error);
    const row: Record<string, unknown> = { label: "x", ghost: "y" };
    expect(prepared.validateRecord(row)).toBe(true);
    expect(row).not.toHaveProperty("ghost");
  });

  test("truncated records array is salvaged to its complete rows", () => {
    const cut =
      '{"total_matching_records":3,"records":[{"label":"a"},{"label":"b"},{"label":"c';
    expect(parseExtractionEnvelope(cut)).toBeNull();
    expect(parseExtractionEnvelope(cut, { salvageTruncation: true })).toEqual({
      records: [{ label: "a" }, { label: "b" }],
      reportedTotal: 3,
    });
  });

  test("non-object garbage parses to null", () => {
    expect(parseExtractionEnvelope("I could not find any records.")).toBeNull();
  });
});

describe("planSections", () => {
  test("splits pages into fixed-size sections", () => {
    const pages = Array.from({ length: 90 }, (_, i) => i + 1);
    const sections = planSections(pages, EXTRACT_SECTION_PAGES);
    expect(sections.map((s) => s.length)).toEqual([40, 40, 10]);
    expect(sections[0]?.[0]).toBe(1);
    expect(sections[2]?.at(-1)).toBe(90);
  });
});
