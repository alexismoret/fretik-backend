import { describe, expect, test } from "bun:test";
import {
  assembleExtractResult,
  buildExtractionSchema,
  EXTRACT_SECTION_PAGES,
  isSparseResult,
  parseExtractionEnvelope,
  planSections,
  recordKey,
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

// Raw JSON equality made a re-sampled row "new" whenever the model
// re-transcribed one character — prod 2026-07-27 returned 50 rows for a
// 28-article document and reported it complete.
describe("recordKey — dedup across independent samples", () => {
  test("re-transcription noise collapses to the same key", () => {
    const a = { label: "CH. GISCOURS 2013  75CL", weight: 418.14 };
    const b = { label: "ch. giscours 2013 75cl ", weight: 418.14 };
    expect(recordKey(a)).toBe(recordKey(b));
  });

  test("accents and key order do not change identity", () => {
    expect(recordKey({ label: "Château", n: 1 })).toBe(
      recordKey({ n: 1, label: "Chateau" }),
    );
  });

  test("genuinely different records stay distinct", () => {
    expect(recordKey({ label: "art 1", weight: 418.14 })).not.toBe(
      recordKey({ label: "art 2", weight: 418.14 }),
    );
    expect(recordKey({ label: "art 1", weight: 418.14 })).not.toBe(
      recordKey({ label: "art 1", weight: 418.15 }),
    );
  });

  test("null is not conflated with an empty string", () => {
    expect(recordKey({ label: null })).not.toBe(recordKey({ label: "" }));
  });
});

// The ONLY trigger for an independent second draw. It used to be joined by
// "the model's count is higher than what came back", which re-extracted whole
// documents on a number measured at 26, then 31, then 1 for the same 21 lines.
describe("isSparseResult — the re-sample trigger is structural", () => {
  test("a handful of rows over many pages qualifies", () => {
    expect(isSparseResult(1, 29, "records")).toBe(true);
    expect(isSparseResult(3, 5, "records")).toBe(true);
  });

  test("a normal harvest does not, however wrong the model's count was", () => {
    expect(isSparseResult(21, 5, "records")).toBe(false);
    expect(isSparseResult(28, 29, "records")).toBe(false);
  });

  test("a short document does not — nothing to be sparse over", () => {
    expect(isSparseResult(1, 2, "records")).toBe(false);
  });

  test("an empty result does not — that has its own notice", () => {
    expect(isSparseResult(0, 29, "records")).toBe(false);
  });

  test("a single-record extraction never re-samples", () => {
    expect(isSparseResult(1, 29, "record")).toBe(false);
  });
});

// `complete` is "no problem was detected". A count that disagrees with the
// rows IS a problem, in both directions — but it says nothing about WHICH of
// the two is wrong: the same 5-page invoice was counted 26, then 31, then 1,
// for 21 real lines (prod 2026-07-29). So it is reported, never acted on.
/** The resolved pair the assembler now takes — a run resolves it once. */
const EXTRACT_MODELS = {
  primaryId: "primary-model",
  fallbackId: "fallback-model",
};

describe("assembleExtractResult — the count must agree with the rows", () => {
  const outcome = (rows: number, reportedTotal: number | null) => ({
    pages: [1, 2, 3],
    // Distinct rows: the merge de-dupes on `recordKey`.
    rows: Array.from({ length: rows }, (_, i) => ({ label: `row ${i + 1}` })),
    singleRecord: null,
    truncated: false,
    reportedTotal,
    failed: false,
    usedFallback: false,
    dropped: 0,
  });

  test("the notice blames neither side — it reports the disagreement", () => {
    const notice = assembleExtractResult(
      [outcome(21, 1)],
      "records",
      5,
      "all",
      EXTRACT_MODELS,
    ).notices.join(" ");
    // Run 2 on 2026-07-29 returned 21 rows for a self-reported count of 1,
    // with no re-sample in the call at all — the notice must not invent one.
    expect(notice).toContain("unreliable");
    expect(notice.toLowerCase()).not.toContain("duplicate");
    expect(notice.toLowerCase()).not.toContain("re-sample");
  });

  test("more rows than counted → not complete, notice names both numbers", () => {
    const result = assembleExtractResult(
      [outcome(32, 26)],
      "records",
      5,
      "all",
      EXTRACT_MODELS,
    );
    expect(result.recordsReturned).toBe(32);
    expect(result.modelCountedTotal).toBe(26);
    expect(result.complete).toBe(false);
    expect(result.notices.join(" ")).toContain("32");
    expect(result.notices.join(" ")).toContain("26");
  });

  test("fewer rows than counted → the shortfall notice still fires", () => {
    const result = assembleExtractResult(
      [outcome(21, 26)],
      "records",
      5,
      "all",
      EXTRACT_MODELS,
    );
    expect(result.complete).toBe(false);
    expect(result.notices).toHaveLength(1);
  });

  test("rows and count agree → complete, no notice", () => {
    const result = assembleExtractResult(
      [outcome(28, 28)],
      "records",
      29,
      "all",
      EXTRACT_MODELS,
    );
    expect(result.complete).toBe(true);
    expect(result.notices).toEqual([]);
  });

  test("no count reported → nothing to disagree with", () => {
    const result = assembleExtractResult(
      [outcome(28, null)],
      "records",
      29,
      "all",
      EXTRACT_MODELS,
    );
    expect(result.modelCountedTotal).toBeNull();
    expect(result.complete).toBe(true);
  });
});
