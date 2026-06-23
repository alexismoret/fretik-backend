import { describe, expect, it } from "bun:test";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../src/db/schema";
import {
  buildRecordShape,
  computeRecordIdentity,
} from "../../src/schemas/record-shape";

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
