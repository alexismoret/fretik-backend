import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { FieldDefinition, FieldDefinitionType } from "../../src/db/schema";

// `record-io.ts` also exports `readRecordData(Batch)`, which default to the
// real `db` client — importing the module (for the pure SQL builder under
// test here) pulls in `../../db`, which throws eagerly if `DATABASE_URL` is
// unset. This suite never opens a connection, so a placeholder is enough.
// Static imports are hoisted before module body code runs, so the stub must
// land BEFORE a dynamic `import()` of the SUT, not a static one.
process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";

const {
  buildExtensionInsert,
  buildExtensionInsertBatch,
  buildExtensionUpdate,
  buildExtensionUpdateBatch,
  extensionColumnCount,
} = await import("../../src/services/collection-schema/record-io");

/**
 * Regression: `bulkUpdateCollectionRecords` builds `UPDATE … AS e SET … FROM
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
  collectionId: "33333333-3333-3333-3333-333333333333",
  key,
  label: key,
  type,
  description: null,
  config: {},
  aiExtractionEnabled: true,
  vectorizeInclude: true,
  displayInPanel: true,
  isTitle: false,
  indexUnusedSince: null,
  indexDroppedAt: null,
  enabled: true,
  displayOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe("buildExtensionUpdateBatch", () => {
  it("emits bare SET targets (no alias-qualified target column)", () => {
    const stmt = buildExtensionUpdateBatch({
      collectionId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
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

/**
 * Regression: a `formula` field IS a physical column, but a `GENERATED ALWAYS
 * AS … STORED` one — Postgres refuses any value for it, `NULL` included. The
 * `replace`-mode builders name every scalar column, so before the fix a bulk
 * import into a type carrying one formula failed WHOLESALE with `cannot insert
 * a non-DEFAULT value into column "…"`, while single-record writes (`patch`
 * mode, which only names present keys) worked — the exact asymmetry seen in
 * prod on 2026-08-28.
 */
describe("generated (formula) columns are never written", () => {
  const fields = [
    makeField("revenue", "money"),
    makeField("cost", "number"),
    makeField("margin", "formula"),
  ];
  const data = { revenue: { amount: 10, currencyCode: "EUR" }, cost: 4 };
  const render = (
    stmt: ReturnType<typeof buildExtensionInsertBatch>,
  ): string => (stmt === null ? "" : new PgDialect().sqlToQuery(stmt).sql);

  it("omits the formula column from the batch INSERT", () => {
    const text = render(
      buildExtensionInsertBatch({
        collectionId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
        fields,
        rows: [
          {
            recordId: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
            teamId: "22222222-2222-2222-2222-222222222222",
            label: "Q1",
            status: "confirmed",
            data,
          },
        ],
      }),
    );
    expect(text).toContain('"revenue_amount"');
    expect(text).toContain('"cost"');
    expect(text).not.toContain('"margin"');
  });

  it("omits the formula column from the full-replace batch UPDATE", () => {
    const text = render(
      buildExtensionUpdateBatch({
        collectionId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
        fields,
        rows: [
          {
            recordId: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
            label: "Q1",
            data,
          },
        ],
      }),
    );
    expect(text).toContain('"cost" = v."cost"');
    expect(text).not.toContain('"margin"');
  });

  it("omits the formula column from the single-row full-replace UPDATE", () => {
    const update = render(
      buildExtensionUpdate({
        collectionId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
        recordId: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
        fields,
        data,
        mode: "replace",
      }),
    );
    expect(update).toContain('"cost" =');
    expect(update).not.toContain('"margin"');
  });

  it("kept the single-row INSERT working, which is why the fault looked like the data", () => {
    // `patch` mode names only the keys present in `data`, and a formula key
    // never is — so this path was correct all along. That asymmetry is what
    // made the incident so hard to read: `manageRecord` wrote one record
    // happily while the SDK's bulk import of the same rows failed outright,
    // which reads as "my rows are bad" rather than "the batch builder is".
    const insert = render(
      buildExtensionInsert({
        collectionId: "019f0b8a-c6e7-7fa7-9ff6-7cc1cdba8862",
        recordId: "019f0b8b-25e8-7b13-acce-2f2162bd81ed",
        teamId: "22222222-2222-2222-2222-222222222222",
        label: "Q1",
        status: "confirmed",
        fields,
        data,
      }),
    );
    expect(insert).toContain('"cost"');
    expect(insert).not.toContain('"margin"');
  });

  it("does not count the formula column when sizing a chunk", () => {
    // money = 2 columns, number = 1, formula = 0.
    expect(extensionColumnCount(fields)).toBe(3);
  });
});
