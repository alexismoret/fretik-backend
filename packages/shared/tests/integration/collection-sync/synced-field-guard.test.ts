import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { deleteFieldDefinition } from "../../../src/services/field-definitions/delete";
import { getFieldDefinitionsForTeam } from "../../../src/services/field-definitions/get-for-team";
import { updateFieldDefinition } from "../../../src/services/field-definitions/update";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { createTableSource } from "./lib/table-source";

/**
 * A column an app fills cannot be dropped, retyped or re-keyed.
 *
 * The rule existed only in the `manageField` tool, which is one of three doors
 * — the HTTP API and any internal caller reached these services with no guard
 * at all. So the screen and the endpoint could do what the agent was told it
 * must not, and two of the three ways to break the binding are SILENT:
 *
 *  - dropping the column leaves the source's mapping naming nothing;
 *  - re-keying it leaves the mapping naming the OLD key, and `ownedFields`
 *    matches on `field.key` — so the source keeps running, keeps reporting
 *    `success`, and never fills that column again.
 *
 * Each test here differs from its neighbour in one thing: whether the column
 * still carries `sync_source_id`. The detach case is what proves the guard is
 * reading that column and not simply refusing everything.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const fieldId = async (collectionId: string, key: string): Promise<string> => {
  const fields = await getFieldDefinitionsForTeam({
    teamId: fx.teamId,
    collectionId,
    includeDisabled: true,
  });
  const field = fields.find((candidate) => candidate.key === key);
  if (field === undefined) throw new Error(`fixture: no field '${key}'`);
  return field.id;
};

const detach = async (id: string): Promise<void> => {
  await db.execute(
    sql`UPDATE field_definitions SET sync_source_id = NULL WHERE id = ${id}::uuid`,
  );
};

describe("a column a connected app fills", () => {
  test("cannot be deleted, and the refusal names the app", async () => {
    const { collectionId } = await createTableSource(fx);
    const id = await fieldId(collectionId, "amount");

    // `cascade` is the flag that normally decides a delete, and it must not be
    // the way around this one: an empty collection carries no values, so the
    // value count alone would wave it through.
    expect(deleteFieldDefinition({ id, cascade: true })).rejects.toThrow(
      /filled by/,
    );

    const fields = await getFieldDefinitionsForTeam({
      teamId: fx.teamId,
      collectionId,
      includeDisabled: true,
    });
    expect(fields.map((f) => f.key)).toContain("amount");
  });

  test("cannot be retyped", async () => {
    const { collectionId } = await createTableSource(fx);
    const id = await fieldId(collectionId, "amount");

    expect(
      updateFieldDefinition({ id, patch: { type: "text" }, cascade: true }),
    ).rejects.toThrow(/filled by/);
  });

  // THE SILENT ONE. Nothing about a renamed key looks wrong afterwards.
  test("cannot be given another key", async () => {
    const { collectionId } = await createTableSource(fx);
    const id = await fieldId(collectionId, "amount");

    expect(
      updateFieldDefinition({ id, patch: { key: "total" } }),
    ).rejects.toThrow(/filled by/);
  });

  test("can still be relabelled and described", async () => {
    const { collectionId } = await createTableSource(fx);
    const id = await fieldId(collectionId, "amount");

    const updated = await updateFieldDefinition({
      id,
      patch: { label: "Montant", description: "What the app charged." },
    });
    expect(updated.label).toBe("Montant");
    expect(updated.key).toBe("amount");
  });

  test("detached, it is an ordinary column again", async () => {
    const { collectionId } = await createTableSource(fx);
    const id = await fieldId(collectionId, "amount");
    await detach(id);

    const retyped = await updateFieldDefinition({
      id,
      patch: { type: "text" },
      cascade: true,
    });
    expect(retyped.type).toBe("text");

    await deleteFieldDefinition({ id, cascade: true });
    const fields = await getFieldDefinitionsForTeam({
      teamId: fx.teamId,
      collectionId,
      includeDisabled: true,
    });
    expect(fields.map((f) => f.key)).not.toContain("amount");
  });
});
