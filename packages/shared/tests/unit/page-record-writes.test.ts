import { beforeEach, describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()`; in a service that happens at boot.
import "@hono/zod-openapi";
import {
  PageOperationSchema,
  type PageOperation,
  type PageValue,
} from "../../src/schemas/pages";
import { mockModule } from "./mock-module";

/**
 * A page writing the team's OWN records — the capability that did not exist
 * until 2026-08-17, and whose absence produced every "the control does nothing"
 * defect from Phase 8 onward.
 *
 * What is checked here is the boundary, because a write path is only as good as
 * what it refuses: the row must be of the type the DEFINITION named and owned
 * by the caller's team, the writable fields are exactly the keys of `args`, and
 * a relation cannot be written as if it were a column. Everything else in this
 * file exists to make those four assertions runnable.
 */

const TEAM = "team-1";
const OTHER_TEAM = "team-2";
const ORG = "org-1";
const TYPE = "01a00000-0000-7000-8000-000000000001";
const OTHER_TYPE = "01a00000-0000-7000-8000-000000000002";

interface RecordRow {
  id: string;
  collectionId: string;
  teamId: string;
}

/** The workspace the mocked database stands for. */
let records: RecordRow[] = [];
let ownedTypes: string[] = [];
let fields: { key: string; type: string; config: Record<string, unknown> }[] =
  [];
let activeLinks: { id: string; fromRecordId: string; toRecordId: string }[] =
  [];

/** What each write service was actually asked to do — null when never called. */
let updatedWith: { id: string; data: Record<string, unknown> }[] | null = null;
let deletedIds: string[] | null = null;
let createdWith: Record<string, unknown> | null = null;
let linkedPair: { from: string; to: string } | null = null;
let invalidatedIds: string[] = [];

const matches = (
  row: RecordRow,
  where: { id?: { in?: string[] }; collectionId?: string; teamId?: string },
): boolean =>
  (where.id?.in === undefined || where.id.in.includes(row.id)) &&
  (where.collectionId === undefined ||
    where.collectionId === row.collectionId) &&
  (where.teamId === undefined || where.teamId === row.teamId);

await mockModule("../../src/db", {
  default: {
    query: {
      collectionRecords: {
        findMany: (args: { where: Parameters<typeof matches>[1] }) =>
          Promise.resolve(records.filter((row) => matches(row, args.where))),
      },
      collections: {
        findFirst: (args: { where: { id: string; teamId: string } }) =>
          Promise.resolve(
            args.where.teamId === TEAM && ownedTypes.includes(args.where.id)
              ? { id: args.where.id }
              : undefined,
          ),
      },
      linkTypes: {
        findFirst: () => Promise.resolve({ id: "link-type-1" }),
      },
      links: {
        findFirst: (args: { where: { toRecordId?: string } }) =>
          Promise.resolve(
            activeLinks.find(
              (edge) => edge.toRecordId === args.where.toRecordId,
            ),
          ),
        findMany: () => Promise.resolve(activeLinks),
      },
    },
  },
});

await mockModule("../../src/services/field-definitions/get-for-team", {
  getFieldDefinitionsForTeam: () => Promise.resolve(fields),
});

await mockModule("../../src/services/collection-records/bulk-update", {
  bulkUpdateCollectionRecords: (input: {
    updates: { id: string; data: Record<string, unknown> }[];
  }) => {
    updatedWith = input.updates;
    return Promise.resolve({
      updatedIds: input.updates.map((u) => u.id),
      errors: [],
    });
  },
});

await mockModule("../../src/services/collection-records/bulk-delete", {
  bulkDeleteCollectionRecords: (input: { ids: string[] }) => {
    deletedIds = input.ids;
    return Promise.resolve({ deletedIds: input.ids, errors: [] });
  },
});

await mockModule("../../src/services/collection-records/create", {
  createCollectionRecord: (input: { data: Record<string, unknown> }) => {
    createdWith = input.data;
    return Promise.resolve({ id: "new-1" });
  },
});

await mockModule("../../src/services/links/create", {
  createLink: (input: { fromRecordId: string; toRecordId: string }) => {
    linkedPair = { from: input.fromRecordId, to: input.toRecordId };
    return Promise.resolve({ id: "edge-new" });
  },
});

await mockModule("../../src/services/links/invalidate", {
  invalidateLink: (input: { id: string }) => {
    invalidatedIds.push(input.id);
    return Promise.resolve({ id: input.id });
  },
});

const { runPageRecordOperation } =
  await import("../../src/services/pages/run-record-operation");

const run = (
  operation: PageOperation,
  state: Record<string, PageValue> = {},
) => {
  if (operation.kind === "app") throw new Error("not this path");
  return runPageRecordOperation({
    operation,
    organizationId: ORG,
    teamId: TEAM,
    userId: "user-1",
    state,
  });
};

const updateOp = (args: Record<string, PageValue>): PageOperation => ({
  kind: "record",
  id: "set_status",
  collectionId: TYPE,
  mode: "update",
  recordId: { var: "row_id" },
  args,
});

beforeEach(() => {
  records = [
    { id: "rec-mine", collectionId: TYPE, teamId: TEAM },
    { id: "rec-other-type", collectionId: OTHER_TYPE, teamId: TEAM },
    { id: "rec-other-team", collectionId: TYPE, teamId: OTHER_TEAM },
  ];
  ownedTypes = [TYPE, OTHER_TYPE];
  fields = [
    { key: "status", type: "select", config: {} },
    { key: "owner", type: "relation", config: { linkTypeKey: "owned_by" } },
    { key: "ref", type: "unique_id", config: {} },
  ];
  activeLinks = [];
  updatedWith = null;
  deletedIds = null;
  createdWith = null;
  linkedPair = null;
  invalidatedIds = [];
});

describe("what the schema refuses before a page is even saved", () => {
  test("an operation written before `kind` existed still parses as an app call", () => {
    // The discriminated union picks its arm BEFORE any `.default()` would run,
    // so the fallback has to be a preprocess — otherwise every stored page with
    // an operation would fail to parse and take the whole definition down.
    const parsed = PageOperationSchema.parse({
      id: "ship",
      providerKey: "acme-orders",
      action: "mark_shipped",
    });
    expect(parsed.kind).toBe("app");
  });

  test("an app operation with no connection at all is refused at write time", () => {
    // It used to validate, save, warn about nothing, and only fail when a user
    // clicked it — the silent authoring trap this closes.
    const result = PageOperationSchema.safeParse({
      kind: "app",
      id: "ship",
      action: "mark_shipped",
    });
    expect(result.success).toBe(false);
  });

  test("an update with no recordId is refused — there is no row to write", () => {
    const result = PageOperationSchema.safeParse({
      kind: "record",
      id: "set_status",
      collectionId: TYPE,
      mode: "update",
      args: { status: "done" },
    });
    expect(result.success).toBe(false);
  });

  test("deleting records without a confirm step is refused", () => {
    for (const kind of ["record", "bulk"] as const) {
      const result = PageOperationSchema.safeParse({
        kind,
        id: "remove",
        collectionId: TYPE,
        mode: "delete",
        ...(kind === "bulk"
          ? { recordIds: ["rec-mine"] }
          : { recordId: "rec-mine" }),
      });
      expect(`${kind}: ${result.success.toString()}`).toBe(`${kind}: false`);
    }
  });

  test("bulk has no create — a selection cannot precede the rows it selects", () => {
    const result = PageOperationSchema.safeParse({
      kind: "bulk",
      id: "add_many",
      collectionId: TYPE,
      mode: "create",
      recordIds: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("what a record write refuses", () => {
  test("a row of ANOTHER type is refused, even though the team owns it", async () => {
    // The declared type is the boundary. Without this check a page over type A
    // could be handed an id of type B and write A's arguments onto it.
    const result = await run(updateOp({ status: "done" }), {
      row_id: "rec-other-type",
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a row of another TEAM is refused", async () => {
    const result = await run(updateOp({ status: "done" }), {
      row_id: "rec-other-team",
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a collection the team does not own is refused before anything runs", async () => {
    ownedTypes = [];
    const result = await run(updateOp({ status: "done" }), {
      row_id: "rec-mine",
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a relation cannot be written as if it were a column", async () => {
    // The record shape STRIPS this key rather than complaining, so without the
    // check the page would save cleanly, toast success and change nothing.
    const result = await run(updateOp({ owner: "someone" }), {
      row_id: "rec-mine",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("owner");
    }
    expect(updatedWith).toBeNull();
  });

  test("a read-only system field is refused the same way", async () => {
    const result = await run(updateOp({ ref: 12 }), { row_id: "rec-mine" });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("an empty selection is named, not silently a no-op", async () => {
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: TYPE,
        mode: "update",
        recordIds: { var: "selection" },
        args: { status: "done" },
      },
      { selection: [] },
    );
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });
});

describe("what it writes", () => {
  test("only the keys the template names reach the row", async () => {
    // The viewer sends both variables; the template references one.
    const result = await run(updateOp({ status: { var: "next" } }), {
      row_id: "rec-mine",
      next: "done",
      note: "should never be written",
    });
    expect(result.status).toBe("ok");
    expect(updatedWith).toEqual([{ id: "rec-mine", data: { status: "done" } }]);
  });

  test("a selection writes once, not once per row", async () => {
    records.push(
      { id: "rec-2", collectionId: TYPE, teamId: TEAM },
      { id: "rec-3", collectionId: TYPE, teamId: TEAM },
    );
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: TYPE,
        mode: "update",
        recordIds: { var: "selection" },
        args: { status: "done" },
      },
      { selection: ["rec-mine", "rec-2", "rec-3"] },
    );
    expect(result.status).toBe("ok");
    expect(updatedWith).toHaveLength(3);
  });

  test("a selection mixing in a foreign row writes the rest and says so", async () => {
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: TYPE,
        mode: "delete",
        recordIds: { var: "selection" },
        confirm: { title: "Delete these?" },
      },
      { selection: ["rec-mine", "rec-other-team"] },
    );
    expect(result.status).toBe("ok");
    expect(deletedIds).toEqual(["rec-mine"]);
    if (result.status === "ok") {
      expect(result.result).toEqual({
        deleted: 1,
        refused: ["rec-other-team"],
      });
    }
  });

  test("create needs no row and passes the resolved template through", async () => {
    const result = await run(
      {
        kind: "record",
        id: "add",
        collectionId: TYPE,
        mode: "create",
        args: { status: { var: "initial" } },
      },
      { initial: "todo" },
    );
    expect(result.status).toBe("ok");
    expect(createdWith).toEqual({ status: "todo" });
  });
});

describe("relations", () => {
  const linkOp = (mode: "link" | "unlink"): PageOperation => ({
    kind: "link",
    id: "assign",
    collectionId: TYPE,
    fieldKey: "owner",
    mode,
    fromRecordId: { var: "row_id" },
    toRecordId: { var: "target" },
  });

  test("linking a cardinality-one relation REPLACES the existing edge", async () => {
    // Without this, "assign an owner" quietly accumulates owners: the edge is
    // idempotent per PAIR, so a second assignment adds a second active edge.
    fields = [
      {
        key: "owner",
        type: "relation",
        config: { linkTypeKey: "owned_by", cardinality: "one" },
      },
    ];
    activeLinks = [
      { id: "edge-old", fromRecordId: "rec-mine", toRecordId: "u1" },
    ];
    const result = await run(linkOp("link"), {
      row_id: "rec-mine",
      target: "u2",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual(["edge-old"]);
    expect(linkedPair).toEqual({ from: "rec-mine", to: "u2" });
  });

  test("a many relation keeps what is already there", async () => {
    fields = [
      {
        key: "owner",
        type: "relation",
        config: { linkTypeKey: "owned_by", cardinality: "many" },
      },
    ];
    activeLinks = [
      { id: "edge-old", fromRecordId: "rec-mine", toRecordId: "u1" },
    ];
    const result = await run(linkOp("link"), {
      row_id: "rec-mine",
      target: "u2",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([]);
  });

  test("a field that is not a relation is refused by name", async () => {
    const result = await run(
      {
        kind: "link",
        id: "assign",
        collectionId: TYPE,
        fieldKey: "status",
        mode: "link",
        fromRecordId: { var: "row_id" },
        toRecordId: { var: "target" },
      },
      { row_id: "rec-mine", target: "u2" },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("status");
    }
    expect(linkedPair).toBeNull();
  });

  test("unlinking an edge that is not there succeeds without inventing one", async () => {
    const result = await run(linkOp("unlink"), {
      row_id: "rec-mine",
      target: "u9",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([]);
  });
});
