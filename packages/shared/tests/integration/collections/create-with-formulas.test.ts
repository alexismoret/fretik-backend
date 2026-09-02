import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { bulkCreateCollectionRecords } from "../../../src/services/collection-records/bulk-create";
import { qualifiedCollectionTable } from "../../../src/services/collection-schema/identifiers";
import {
  type CollectionFieldInput,
  createCollectionWithFields,
} from "../../../src/services/collections/create-with-fields";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Creating a collection and its computed columns in ONE call.
 *
 * From the incident of 2026-08-28, where it took four: the batch create was
 * refused because the formula named a key that did not exist, and the three
 * formulas then had to be added one by one afterwards. Two causes, both here:
 * keys are slugified from labels, so an agent writing a formula in the same
 * call is guessing what to name; and the batch path never compiled a formula
 * before the DDL, so the failure arrived as a bare sentence from inside the
 * schema builder rather than as a message naming the field.
 *
 * Integration because the correctness IS the SQL: a `formula` becomes a
 * `GENERATED ALWAYS AS … STORED` column whose expression the compiler emits and
 * whose type it infers. Nothing short of a real table proves that the column
 * exists, computes, and carries the right type — a doubled DDL would only prove
 * the double.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

let seq = 0;
const create = (fields: CollectionFieldInput[]) =>
  createCollectionWithFields({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    key: `deal_${(seq++).toString()}`,
    label: "Deal",
    description: "Test collection",
    fields,
  });

/** The stored fields every case below shares, with keys chosen by the caller. */
const revenue: CollectionFieldInput = {
  label: 'Revenu reconnu "REV"',
  key: "revenue",
  type: "number",
  description: "Recognised revenue",
};
const cost: CollectionFieldInput = {
  label: "Coût reconnu",
  key: "cost",
  type: "number",
  description: "Recognised cost",
};

describe("one call, stored fields and formulas together", () => {
  test("creates the whole schema and the generated columns compute", async () => {
    const created = await create([
      revenue,
      cost,
      {
        label: "Marge",
        key: "margin",
        type: "formula",
        description: "Revenue minus cost",
        config: { expression: "revenue - cost" },
      },
      {
        // A formula reading another formula: legal because the compiler INLINES
        // it (Postgres forbids a generated column referencing another), and the
        // case the incident never got to test in one call.
        label: "Marge doublée",
        key: "margin_x2",
        type: "formula",
        description: "Margin, twice",
        config: { expression: "margin * 2" },
      },
    ]);

    const { errors } = await bulkCreateCollectionRecords({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: created.id,
      rows: [{ data: { revenue: 100, cost: 40 } }],
      actor: { actorType: "user", actorUserId: fx.userIds[0] },
    });
    expect(errors).toEqual([]);

    const computed = await db.execute<{ margin: number; margin_x2: number }>(
      sql`SELECT margin, margin_x2 FROM ${sql.raw(qualifiedCollectionTable(created.id))}`,
    );
    expect(computed.rows[0]?.margin).toBe(60);
    expect(computed.rows[0]?.margin_x2).toBe(120);
  });

  test("infers the result type instead of defaulting the column to a number", async () => {
    // Before the batch path compiled anything, `resultType` stayed unset and
    // `formulaSqlType` fell back to `double precision` — so a text formula
    // failed in the DDL with Postgres complaining about types, naming neither
    // the field nor the expression.
    const created = await create([
      { label: "First", key: "first_name", type: "text", description: "First" },
      { label: "Last", key: "last_name", type: "text", description: "Last" },
      {
        label: "Full",
        key: "full_name",
        type: "formula",
        description: "Both names",
        config: { expression: 'concat(first_name, " ", last_name)' },
      },
    ]);

    const formula = created.fieldDefinitions.find((f) => f.key === "full_name");
    expect(formula?.config).toMatchObject({ resultType: "text" });

    const columns = await db.execute<{ data_type: string }>(
      sql`SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'data'
            AND table_name = ${qualifiedCollectionTable(created.id).split(".")[1]}
            AND column_name = 'full_name'`,
    );
    expect(columns.rows[0]?.data_type).toBe("text");
  });
});

describe("what a bad batch is told, and what it leaves behind", () => {
  test("names the field, the position and the keys that DO exist", async () => {
    const error = await rejection(
      create([
        revenue,
        cost,
        {
          label: "Profit total",
          type: "formula",
          description: "Wrong reference",
          // The incident verbatim: the agent named the source file's column
          // instead of the key its own batch was creating.
          config: { expression: "total_income + total_expense" },
        },
      ]),
    );

    const message = error.message;
    expect(message).toContain("Profit total");
    expect(message).toContain("total_income");
    // The part that turns a retry into a correction: the batch's own keys.
    expect(message).toContain("revenue");
    expect(message).toContain("cost");
  });

  test("leaves no half-built collection behind", async () => {
    const key = `rolled_back_${(seq++).toString()}`;
    await rejection(
      createCollectionWithFields({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        key,
        label: "Rolled back",
        description: "Test collection",
        fields: [
          revenue,
          {
            label: "Broken",
            key: "broken",
            type: "formula",
            description: "Names nothing",
            config: { expression: "nope + 1" },
          },
        ],
      }),
    );

    const rows = await db.query.collections.findMany({
      where: { teamId: fx.teamId, key },
    });
    expect(rows).toEqual([]);
  });

  test("refuses two fields claiming the same key, in its own words", async () => {
    // Suffixing the second to `revenue_2` would silently point any formula
    // naming `revenue` at the wrong column.
    //
    // The assertion is on the SENTENCE, not just on the refusal: without the
    // guard the insert still fails — on a unique index, with a Postgres message
    // that also contains "revenue". A test satisfied by that would pass while
    // the collision was being reported as a database fault rather than as the
    // caller's mistake.
    const error = await rejection(
      create([revenue, { ...cost, key: "revenue" }]),
    );
    expect(error.message).toContain("Two fields share the key");
    expect(error.message).toContain("revenue");
  });
});
