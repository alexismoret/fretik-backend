import { describe, expect, test } from "bun:test";
import {
  assembleExtractResult,
  EXTRACT_PAGES_PER_CHUNK,
  EXTRACT_RECORD_MODE_MAX_PAGES,
  planPageChunks,
  planTextChunks,
  prepareExtractionSchema,
  sanitizeExtractSchema,
  selectRecordModePages,
} from "../../../src/lib/structured-extract";

const RECORD_SCHEMA = {
  type: "object",
  description: "One line item",
  properties: {
    label: { type: "string", description: "Item label" },
    qty: { type: "number", minimum: 0 },
    kind: { type: "string", enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" }, maxItems: 10 },
    dims: {
      type: "object",
      properties: {
        w: { type: "number" },
        h: { type: "number" },
      },
      required: ["w"],
    },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: { ref: { type: "string" } },
      },
    },
  },
  required: ["label"],
};

describe("sanitizeExtractSchema", () => {
  test("accepts a nested schema and auto-admits null on scalar/enum leaves", () => {
    const result = sanitizeExtractSchema(RECORD_SCHEMA);
    if ("error" in result) throw new Error(result.error);
    const properties = result.properties ?? {};
    const label = properties["label"];
    const kind = properties["kind"];
    const dims = properties["dims"];
    if (
      typeof label !== "object" ||
      typeof kind !== "object" ||
      typeof dims !== "object" ||
      dims === null ||
      Array.isArray(dims)
    ) {
      throw new Error("expected object property schemas");
    }
    expect(label).toHaveProperty("type", ["string", "null"]);
    expect(kind).toHaveProperty("enum", ["a", "b", null]);
    // Container types are left alone (empty container instead of null).
    expect(dims).toHaveProperty("type", "object");
    // Nested object properties get the same null treatment.
    const w = (dims.properties ?? {})["w"];
    expect(w).toHaveProperty("type", ["number", "null"]);
  });

  test("rejects non-object top level and empty properties", () => {
    expect(sanitizeExtractSchema({ type: "string" })).toHaveProperty("error");
    expect(
      sanitizeExtractSchema({ type: "object", properties: {} }),
    ).toHaveProperty("error");
    expect(sanitizeExtractSchema("nope")).toHaveProperty("error");
  });

  test("bounds nesting depth", () => {
    const deep = { type: "object", properties: {} };
    let cursor: Record<string, unknown> = deep;
    for (let level = 0; level < 9; level++) {
      const child: Record<string, unknown> = { type: "object", properties: {} };
      cursor["properties"] = { nested: child };
      cursor = child;
    }
    cursor["properties"] = { leaf: { type: "string" } };
    expect(sanitizeExtractSchema(deep)).toHaveProperty("error");
  });

  test("validates keyword value types", () => {
    expect(
      sanitizeExtractSchema({
        type: "object",
        properties: { a: { type: "string", minLength: "2" } },
      }),
    ).toHaveProperty("error");
    expect(
      sanitizeExtractSchema({
        type: "object",
        properties: { a: { enum: [] } },
      }),
    ).toHaveProperty("error");
    expect(
      sanitizeExtractSchema({
        type: "object",
        properties: { a: { type: "banana" } },
      }),
    ).toHaveProperty("error");
  });
});

/** Assert the sanitized schema is an object schema and return its properties. */
const propsOf = (raw: unknown): Record<string, Record<string, unknown>> => {
  const result = sanitizeExtractSchema(raw);
  if ("error" in result) throw new Error(result.error);
  const properties = result.properties ?? {};
  const typed: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`property ${name} is not an object schema`);
    }
    typed[name] = value;
  }
  return typed;
};

describe("sanitizeExtractSchema — draft-07 lowering", () => {
  test("wraps a bare property map into an object schema", () => {
    const props = propsOf({
      code: { type: "string" },
      amount: { type: "number" },
    });
    expect(Object.keys(props)).toEqual(["code", "amount"]);
  });

  test("wraps nested bare property maps too", () => {
    const props = propsOf({
      customer: { name: { type: "string" }, id: { type: "string" } },
    });
    expect(props["customer"]).toHaveProperty("type", "object");
    expect(Object.keys(props["customer"]?.["properties"] ?? {})).toEqual([
      "name",
      "id",
    ]);
  });

  test("keeps a field literally named 'description' when it holds a schema", () => {
    const props = propsOf({
      description: { type: "string" },
      amount: { type: "number" },
    });
    expect(Object.keys(props)).toContain("description");
  });

  test("collapses an anyOf null-branch into a nullable type", () => {
    const props = propsOf({
      type: "object",
      properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
    expect(props["note"]).toHaveProperty("type", ["string", "null"]);
  });

  test("collapses oneOf to the first non-null branch", () => {
    const props = propsOf({
      type: "object",
      properties: { val: { oneOf: [{ type: "number" }, { type: "string" }] } },
    });
    expect(props["val"]).toHaveProperty("type", ["number", "null"]);
  });

  test("normalizes nullable:true (OpenAPI) into the type", () => {
    const props = propsOf({
      type: "object",
      properties: { ref: { type: "string", nullable: true } },
    });
    expect(props["ref"]).toHaveProperty("type", ["string", "null"]);
  });

  test("lifts field definitions misplaced next to properties into them", () => {
    // Observed in prod: the model put `format` (a string keyword) and a
    // non-keyword field as SIBLINGS of `properties` inside items.
    const asNode = (value: unknown): Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("not an object schema node");
      }
      return { ...value };
    };
    const props = propsOf({
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { description: { type: "string" } },
            format: { type: "string", description: "bottle format" },
            quantite: { type: "number" },
          },
        },
      },
    });
    const items = asNode(props["lines"]?.["items"]);
    const itemProps = asNode(items["properties"]);
    expect(Object.keys(itemProps).sort()).toEqual([
      "description",
      "format",
      "quantite",
    ]);
  });

  test("drops a non-array required instead of erroring", () => {
    const props = propsOf({
      type: "object",
      properties: {
        lines: {
          type: "array",
          items: {
            type: "object",
            properties: { label: { type: "string" } },
            required: true,
          },
        },
      },
    });
    const items = props["lines"]?.["items"];
    expect(items).not.toHaveProperty("required");
  });

  test("still rejects an empty schema with the object-shape message", () => {
    const result = sanitizeExtractSchema({});
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toContain("must describe an object");
    }
  });

  test("inlines a local $ref against $defs", () => {
    const props = propsOf({
      type: "object",
      properties: { line: { $ref: "#/$defs/Line" } },
      $defs: {
        Line: { type: "object", properties: { label: { type: "string" } } },
      },
    });
    expect(props["line"]).toHaveProperty("type", "object");
    expect(Object.keys(props["line"]?.["properties"] ?? {})).toEqual(["label"]);
  });

  test("merges allOf members into one object", () => {
    const props = propsOf({
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(Object.keys(props).sort()).toEqual(["a", "b"]);
  });

  test("coerces array-form properties into a map", () => {
    const props = propsOf({
      type: "object",
      properties: [
        { name: "code", type: "string" },
        { name: "amount", type: "number" },
      ],
    });
    expect(Object.keys(props)).toEqual(["code", "amount"]);
  });

  test("drops annotation keywords instead of erroring", () => {
    const props = propsOf({
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "urn:x",
      title: "Invoice",
      type: "object",
      properties: {
        amount: { type: "number", default: 0, examples: [1], readOnly: true },
      },
    });
    expect(props["amount"]).not.toHaveProperty("default");
    expect(props["amount"]).not.toHaveProperty("examples");
    expect(props["amount"]).not.toHaveProperty("readOnly");
  });

  test("infers type:string for a described leaf with no type", () => {
    const props = propsOf({
      type: "object",
      properties: { note: { description: "free text note" } },
    });
    expect(props["note"]).toHaveProperty("type", ["string", "null"]);
  });

  test("prunes required entries that reference no property", () => {
    const result = sanitizeExtractSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.required).toEqual(["a"]);
  });

  test("still rejects a genuinely un-lowerable schema", () => {
    expect(sanitizeExtractSchema({})).toHaveProperty("error");
    expect(sanitizeExtractSchema({ type: "object" })).toHaveProperty("error");
  });
});

describe("prepareExtractionSchema", () => {
  test("wraps records shape and validates output through Ajv", () => {
    const prepared = prepareExtractionSchema(RECORD_SCHEMA, "records");
    if ("error" in prepared) throw new Error(prepared.error);
    expect(prepared.promptSchema).toContain('"records"');
    const validate = prepared.outputSchema.validate;
    if (validate === undefined) throw new Error("expected a validate fn");

    const ok = validate({
      records: [
        {
          label: "x",
          qty: 2,
          kind: null,
          tags: ["t"],
          dims: { w: 1, h: null },
          lines: [{ ref: null }],
        },
      ],
    });
    expect(ok).toEqual(expect.objectContaining({ success: true }));

    const bad = validate({ records: [{ label: "x", qty: -1 }] });
    expect(bad).toEqual(expect.objectContaining({ success: false }));

    const wrongShape = validate({ record: { label: "x" } });
    expect(wrongShape).toEqual(expect.objectContaining({ success: false }));
  });

  test("wraps record shape", () => {
    const prepared = prepareExtractionSchema(RECORD_SCHEMA, "record");
    if ("error" in prepared) throw new Error(prepared.error);
    const validate = prepared.outputSchema.validate;
    if (validate === undefined) throw new Error("expected a validate fn");
    expect(validate({ record: { label: "x" } })).toEqual(
      expect.objectContaining({ success: true }),
    );
  });

  test("propagates sanitize errors", () => {
    expect(
      prepareExtractionSchema({ type: "array" }, "records"),
    ).toHaveProperty("error");
  });
});

describe("chunk planning", () => {
  test("planPageChunks splits 29 pages into 8/8/8/5", () => {
    const pages = Array.from({ length: 29 }, (_, index) => index + 1);
    const chunks = planPageChunks(pages, EXTRACT_PAGES_PER_CHUNK);
    expect(chunks.map((chunk) => chunk.length)).toEqual([8, 8, 8, 5]);
    expect(chunks[0]?.[0]).toBe(1);
    expect(chunks[3]?.[4]).toBe(29);
  });

  test("selectRecordModePages keeps head + tail on large docs", () => {
    const pages = Array.from({ length: 40 }, (_, index) => index + 1);
    const selected = selectRecordModePages(pages);
    expect(selected).toHaveLength(EXTRACT_RECORD_MODE_MAX_PAGES);
    expect(selected.slice(0, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(selected.slice(-6)).toEqual([35, 36, 37, 38, 39, 40]);
    expect(selectRecordModePages([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("planTextChunks respects the char budget and keeps page order", () => {
    const pages = [
      { pageNumber: 1, markdown: "a".repeat(50) },
      { pageNumber: 2, markdown: "b".repeat(60) },
      { pageNumber: 3, markdown: "c".repeat(10) },
    ];
    const chunks = planTextChunks(pages, 100);
    expect(chunks.map((chunk) => chunk.map((page) => page.pageNumber))).toEqual(
      [[1], [2, 3]],
    );
  });
});

describe("assembleExtractResult", () => {
  const outcomeBase = {
    singleRecord: null,
    truncated: false,
    failed: false,
    usedFallback: false,
  };

  test("merges rows in chunk order and reports complete", () => {
    const result = assembleExtractResult(
      [
        { ...outcomeBase, pages: [1, 2], rows: [{ n: 1 }, { n: 2 }] },
        { ...outcomeBase, pages: [3, 4], rows: [{ n: 3 }] },
      ],
      "records",
      4,
      "1-4",
    );
    expect(result.complete).toBe(true);
    expect(result.data).toEqual({ records: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    expect(result.chunks).toBe(2);
  });

  test("truncated and failed chunks produce page-targeted notices", () => {
    const result = assembleExtractResult(
      [
        { ...outcomeBase, pages: [1, 2], rows: [{ n: 1 }], truncated: true },
        { ...outcomeBase, pages: [3, 4], rows: [], failed: true },
      ],
      "records",
      4,
      "1-4",
    );
    expect(result.complete).toBe(false);
    expect(result.notices).toHaveLength(2);
    expect(result.notices[0]).toContain('pages:"1-2"');
    expect(result.notices[1]).toContain('pages:"3-4"');
  });

  test("a backend-unavailable failure steers to read + python, not a retry loop", () => {
    const result = assembleExtractResult(
      [
        {
          ...outcomeBase,
          pages: [1, 2],
          rows: [],
          failed: true,
          unavailable: true,
          error: "No endpoints found matching your data policy",
        },
      ],
      "records",
      2,
      "1-2",
    );
    expect(result.complete).toBe(false);
    expect(result.notices[0]).toContain("unavailable");
    expect(result.notices[0]).toContain("read + python");
    expect(result.notices[0]).toContain(
      "No endpoints found matching your data policy",
    );
    // Never tells the agent to re-call extract on a deterministic outage.
    expect(result.notices[0]).not.toContain("re-call extract");
  });

  test("record shape returns the first non-null record and flags fallback use", () => {
    const result = assembleExtractResult(
      [
        {
          ...outcomeBase,
          pages: [1],
          rows: [],
          singleRecord: { total: 12.5 },
          usedFallback: true,
        },
      ],
      "record",
      1,
      "1",
    );
    expect(result.data).toEqual({ record: { total: 12.5 } });
    expect(result.model).toContain("+");
  });
});
