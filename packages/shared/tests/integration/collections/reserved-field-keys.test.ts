import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { qualifiedCollectionTable } from "../../../src/services/collection-schema/identifiers";
import { createSyncSource } from "../../../src/services/collection-sync/create-source";
import { createCollectionWithFields } from "../../../src/services/collections/create-with-fields";
import { createFieldDefinition } from "../../../src/services/field-definitions/create";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * `id`, `created_at` and `updated_at` are the columns every collection already
 * has, so no field may take those keys. The DDL layer enforces that by
 * THROWING, which is right for a last line of defence and wrong for everything
 * upstream of it: a caller who asks for one got a 500.
 *
 * And they ask constantly. A column labelled "Id" slugifies to `id`, and
 * `POST /collection-sync/preview` offers the app's own `id` as a column with
 * the box already ticked — so the default mapping of almost every read action
 * asked for the one key that could not be granted. Observed in the browser on
 * 2026-09-19: the "from an app" composer created the collection, the source
 * create answered 500, and the user was left with an empty table and no source.
 *
 * Integration because the resolution IS a query: which keys are free is read
 * from `field_definitions`, and the column the caller ends up with has to
 * actually exist in `data.coll_<id>`.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const collection = async (): Promise<{ id: string }> =>
  createCollectionWithFields({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    key: `item_${randomUUID().slice(0, 8)}`,
    label: "Item",
    fields: [{ label: "Label", key: "label", type: "text", isTitle: true }],
  });

/** The column names the physical table actually carries. */
const columnsOf = async (collectionId: string): Promise<string[]> => {
  const result = await db.execute<{ column_name: string }>(sql`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'data'
       AND table_name = ${qualifiedCollectionTable(collectionId).split(".")[1]}`);
  return result.rows.map((r) => r.column_name);
};

describe("a reserved key is a collision, not a crash", () => {
  test("a column labelled 'Id' is created under a derived key", async () => {
    const created = await collection();
    const field = await createFieldDefinition({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: created.id,
      label: "Id",
      type: "text",
    });

    // Not `id` — that one belongs to the collection — but a real, usable key.
    expect(field.key).not.toBe("id");
    expect(field.key).toMatch(/^[a-z][a-z0-9_]*$/);
    // And the column is really there: a key the catalogue accepts but the DDL
    // refuses would leave a field definition describing nothing.
    expect(await columnsOf(created.id)).toContain(field.key);
  });

  test("'Created at' and 'Updated at' get the same treatment", async () => {
    const created = await collection();
    const createdAt = await createFieldDefinition({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: created.id,
      label: "Created at",
      type: "date",
    });
    const updatedAt = await createFieldDefinition({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      collectionId: created.id,
      label: "Updated at",
      type: "date",
    });
    expect(createdAt.key).not.toBe("created_at");
    expect(updatedAt.key).not.toBe("updated_at");
    const columns = await columnsOf(created.id);
    expect(columns).toContain(createdAt.key);
    expect(columns).toContain(updatedAt.key);
  });

  test("asking for the key outright is refused by name, not by 500", async () => {
    const created = await collection();
    const error = await rejection(
      createFieldDefinition({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        collectionId: created.id,
        key: "id",
        label: "External id",
        type: "text",
      }),
    );
    // The message has to carry the key back: an agent reading "an unexpected
    // error occurred" retries the same call.
    expect(error.message).toContain("BAD_REQUEST");
    expect(error.message).toContain("'id'");
    expect(error.message).toContain("already has");
  });
});

describe("a sync source maps the app's own id", () => {
  test("creates the source and a column, under a key that is not `id`", async () => {
    const created = await collection();
    const connection = await fx.createConnection();

    const source = await createSyncSource({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: fx.userIds[0] ?? null,
      collectionId: created.id,
      kind: "table",
      connectionId: connection.id,
      providerKey: connection.providerKey,
      operation: "list_items",
      args: {},
      externalIdPath: "id",
      schedule: { mode: "manual" },
      orphanPolicy: "keep",
      // Exactly what the preview pre-selects: the app's `id`, plus one
      // ordinary column so the mapping is not a single special case.
      fields: [
        { path: "id", label: "Id", type: "number" },
        { path: "item_code", label: "Item code", type: "text" },
      ],
    });

    const mapped = source.fieldMapping.find((m) => m.path === "id");
    if (mapped === undefined) throw new Error("the id path was not mapped");
    expect(mapped.fieldKey).not.toBe("id");

    const columns = await columnsOf(created.id);
    expect(columns).toContain(mapped.fieldKey);
    expect(columns).toContain("item_code");
  });
});
