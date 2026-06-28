import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type {
  FieldDefinition,
  FieldDefinitionConfig,
  FieldDefinitionType,
} from "../../src/db/schema";
import { buildExtensionUpdateBatch } from "../../src/services/object-schema/record-io";

/**
 * Regression: `bulkUpdateObjectRecords` builds `UPDATE … AS e SET … FROM
 * (VALUES …) AS v`. Postgres rejects an alias-qualified SET TARGET
 * (`SET e."x" = …` is a syntax error); the target must be bare and only the
 * source reads from `v`. A prior bug emitted `e.${c}` on the target, so every
 * Python-SDK `bulk_update` failed with "Failed query".
 */

let seq = 0;
const makeField = (
  key: string,
  type: FieldDefinitionType,
): FieldDefinition => ({
  id: `00000000-0000-7000-0000-${(seq++).toString().padStart(12, "0")}`,
  organizationId: "11111111-1111-1111-1111-111111111111",
  teamId: "22222222-2222-2222-2222-222222222222",
  objectTypeId: "33333333-3333-3333-3333-333333333333",
  key,
  label: key,
  type,
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
});

describe("buildExtensionUpdateBatch", () => {
  it("emits bare SET targets (no alias-qualified target column)", () => {
    const stmt = buildExtensionUpdateBatch({
      objectTypeId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
      fields: [makeField("name", "text"), makeField("regions", "multi_select")],
      rows: [
        {
          recordId: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
          label: "Northwind Trading",
          data: { name: "Northwind Trading", regions: ["emea", "apac"] },
        },
      ],
    });
    expect(stmt).not.toBeNull();
    if (stmt === null) return;
    const { sql: text } = new PgDialect().sqlToQuery(stmt);

    // Bare targets, source reads from the VALUES alias `v`.
    expect(text).toContain('SET "_label" = v."_label"');
    expect(text).toContain('"name" = v."name"');
    expect(text).toContain('"regions" = v."regions"');
    // A batch update bumps `updated_at` (a now() expression, not a VALUES col).
    expect(text).toContain('"updated_at" = now()');
    // The join key stays qualified in the WHERE — that's valid.
    expect(text).toContain('WHERE e."id" = v."id"');
    // The bug: an alias-qualified SET target. Must never appear.
    expect(text).not.toContain('e."_label" =');
    expect(text).not.toContain('e."name" =');
    expect(text).not.toContain('e."regions" =');
  });
});
