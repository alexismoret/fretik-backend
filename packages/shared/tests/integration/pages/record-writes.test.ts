import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { PageOperation, PageValue } from "../../../src/schemas/pages";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * A page writing the team's OWN records — the capability that did not exist
 * until 2026-08-17, and whose absence produced every "the control does nothing"
 * defect from Phase 8 onward.
 *
 * What is checked here is the boundary, because a write path is only as good as
 * what it refuses: the row must be of the type the DEFINITION named and owned
 * by the caller's team, the writable fields are exactly the keys of `args`, and
 * a relation cannot be written as if it were a column.
 *
 * This was a unit test with a faked `db` until 2026-09-02. The fake carried a
 * hand-written `matches(row, where)` that re-implemented the predicate in
 * JavaScript, so "a row of another TEAM is refused" asserted that the FAKE had
 * filtered — delete `teamId` from `ownedRecordIds` and the test stayed green.
 * Two of its collaborators were worse than useless: `linkTypes.findFirst`
 * answered `{ id: "link-type-1" }` to every query, so a link type belonging to
 * someone else was indistinguishable from one's own, and `links.findMany`
 * returned the whole fixture list, so the bi-temporal clauses that keep a dead
 * edge dead were never executed.
 *
 * The record and link WRITE services stay doubled. They enforce tenancy
 * themselves and have their own suites; what had to become real is every read
 * that decides WHETHER a write may happen, and the ids it is allowed to touch.
 */

let fx: WorkspaceFixture;
let otherTeamId: string;

/** The page's declared collection, and the fields it may write. */
let typeId: string;
/** Another collection of the same team — a row of the wrong type. */
let otherTypeId: string;
/** A collection owned by the other team, used as the page's declared type. */
let unownedTypeId: string;

let recMine: string;
let recOtherType: string;
let recOtherTeam: string;

/** What each write service was actually asked to do — null when never called. */
let updatedWith: { id: string; data: Record<string, unknown> }[] | null = null;
let deletedIds: string[] | null = null;
let createdWith: Record<string, unknown> | null = null;
let linkedPair: { from: string; to: string } | null = null;
let invalidatedIds: string[] = [];

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
  await import("../../../src/services/pages/run-record-operation");

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherTeamId = (await fx.createTeam()).id;

  const type = await fx.createCollection();
  typeId = type.id;
  otherTypeId = (await fx.createCollection()).id;
  unownedTypeId = (await fx.createCollection({ teamId: otherTeamId })).id;

  await fx.createField({ collectionId: typeId, key: "status", type: "select" });
  await fx.createField({
    collectionId: typeId,
    key: "owner",
    type: "relation",
    config: { linkTypeKey: "owned_by" },
  });
  await fx.createField({
    collectionId: typeId,
    key: "ref",
    type: "unique_id",
  });

  recMine = (await fx.createRecord({ collectionId: typeId })).id;
  recOtherType = (await fx.createRecord({ collectionId: otherTypeId })).id;
  // The row that makes `teamId` load-bearing: same collection, other owner.
  recOtherTeam = (
    await fx.createRecord({ collectionId: typeId, teamId: otherTeamId })
  ).id;
});

afterAll(async () => {
  await fx.cleanup();
});

beforeEach(() => {
  updatedWith = null;
  deletedIds = null;
  createdWith = null;
  linkedPair = null;
  invalidatedIds = [];
});

const run = (
  operation: PageOperation,
  state: Record<string, PageValue> = {},
) => {
  if (operation.kind === "app") throw new Error("not this path");
  return runPageRecordOperation({
    operation,
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userIds[0],
    state,
  });
};

const updateOp = (
  args: Record<string, PageValue>,
  collectionId = typeId,
): PageOperation => ({
  kind: "record",
  id: "set_status",
  collectionId,
  mode: "update",
  recordId: { var: "row_id" },
  args,
});

describe("what a record write refuses", () => {
  test("a row of ANOTHER type is refused, even though the team owns it", async () => {
    // The declared type is the boundary. Without this check a page over type A
    // could be handed an id of type B and write A's arguments onto it.
    const result = await run(updateOp({ status: "done" }), {
      row_id: recOtherType,
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a row of another TEAM is refused", async () => {
    // Same collection, same organization, different owning team — the only
    // shape that fails when `teamId` leaves the WHERE.
    const result = await run(updateOp({ status: "done" }), {
      row_id: recOtherTeam,
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a record id that does not exist at all is refused", async () => {
    const result = await run(updateOp({ status: "done" }), {
      row_id: "01a00000-0000-7000-8000-0000000000ff",
    });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("a collection the team does not own is refused before anything runs", async () => {
    const result = await run(updateOp({ status: "done" }, unownedTypeId), {
      row_id: recMine,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("does not own");
    }
    expect(updatedWith).toBeNull();
  });

  test("a relation cannot be written as if it were a column", async () => {
    // The record shape STRIPS this key rather than complaining, so without the
    // check the page would save cleanly, toast success and change nothing.
    const result = await run(updateOp({ owner: "someone" }), {
      row_id: recMine,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("owner");
    }
    expect(updatedWith).toBeNull();
  });

  test("a read-only system field is refused the same way", async () => {
    const result = await run(updateOp({ ref: 12 }), { row_id: recMine });
    expect(result.status).toBe("error");
    expect(updatedWith).toBeNull();
  });

  test("an empty selection is named, not silently a no-op", async () => {
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: typeId,
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
      row_id: recMine,
      next: "done",
      note: "should never be written",
    });
    expect(result.status).toBe("ok");
    expect(updatedWith).toEqual([{ id: recMine, data: { status: "done" } }]);
  });

  test("a selection writes once, not once per row", async () => {
    const extra = [
      (await fx.createRecord({ collectionId: typeId })).id,
      (await fx.createRecord({ collectionId: typeId })).id,
    ];
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: typeId,
        mode: "update",
        recordIds: { var: "selection" },
        args: { status: "done" },
      },
      { selection: [recMine, ...extra] },
    );
    expect(result.status).toBe("ok");
    expect(updatedWith).toHaveLength(3);
  });

  test("a selection mixing in a foreign row writes the rest and says so", async () => {
    const result = await run(
      {
        kind: "bulk",
        id: "approve_all",
        collectionId: typeId,
        mode: "delete",
        recordIds: { var: "selection" },
        confirm: { title: "Delete these?" },
      },
      { selection: [recMine, recOtherTeam] },
    );
    expect(result.status).toBe("ok");
    expect(deletedIds).toEqual([recMine]);
    if (result.status === "ok") {
      expect(result.result).toEqual({ deleted: 1, refused: [recOtherTeam] });
    }
  });

  test("create needs no row and passes the resolved template through", async () => {
    const result = await run(
      {
        kind: "record",
        id: "add",
        collectionId: typeId,
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
  /**
   * Each cardinality gets its OWN collection.
   *
   * `getFieldDefinitionsForTeam` caches per (team, collection), so a suite that
   * rewrote one field's config between tests would read the previous test's
   * answer out of Redis and assert nothing.
   */
  const relationCollection = async (cardinality: "one" | "many") => {
    const collection = await fx.createCollection();
    const key = `owned_by_${cardinality}`;
    await fx.createField({
      collectionId: collection.id,
      key: "owner",
      type: "relation",
      config: { linkTypeKey: key, cardinality },
    });
    await fx.createField({
      collectionId: collection.id,
      key: "status",
      type: "select",
    });
    const linkType = await fx.createLinkType({
      key,
      fromCollectionId: collection.id,
    });
    const from = await fx.createRecord({ collectionId: collection.id });
    const targets = [
      (await fx.createRecord({ collectionId: collection.id })).id,
      (await fx.createRecord({ collectionId: collection.id })).id,
    ];
    return {
      collectionId: collection.id,
      linkTypeId: linkType.id,
      from,
      targets,
    };
  };

  const linkOp = (
    collectionId: string,
    mode: "link" | "unlink",
    fieldKey = "owner",
  ): PageOperation => ({
    kind: "link",
    id: "assign",
    collectionId,
    fieldKey,
    mode,
    fromRecordId: { var: "row_id" },
    toRecordId: { var: "target" },
  });

  test("linking a cardinality-one relation REPLACES the existing edge", async () => {
    // Without this, "assign an owner" quietly accumulates owners: the edge is
    // idempotent per PAIR, so a second assignment adds a second active edge.
    const c = await relationCollection("one");
    const old = await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[0] ?? "",
    });
    const result = await run(linkOp(c.collectionId, "link"), {
      row_id: c.from.id,
      target: c.targets[1] ?? "",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([old.id]);
    expect(linkedPair).toEqual({ from: c.from.id, to: c.targets[1] ?? "" });
  });

  test("an edge already invalidated is not invalidated a second time", async () => {
    // The bi-temporal clauses are the whole reason `findMany` has four
    // predicates. A fake that returned "the active links" could not fail here.
    const c = await relationCollection("one");
    await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[0] ?? "",
      invalidatedAt: new Date(),
    });
    const result = await run(linkOp(c.collectionId, "link"), {
      row_id: c.from.id,
      target: c.targets[1] ?? "",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([]);
  });

  test("replacing one record's owner leaves another record's edge alone", async () => {
    const c = await relationCollection("one");
    const neighbour = await fx.createRecord({ collectionId: c.collectionId });
    await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: neighbour.id,
      toRecordId: c.targets[0] ?? "",
    });
    const result = await run(linkOp(c.collectionId, "link"), {
      row_id: c.from.id,
      target: c.targets[1] ?? "",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([]);
  });

  test("a many relation keeps what is already there", async () => {
    const c = await relationCollection("many");
    await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[0] ?? "",
    });
    const result = await run(linkOp(c.collectionId, "link"), {
      row_id: c.from.id,
      target: c.targets[1] ?? "",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([]);
  });

  test("a field that is not a relation is refused by name", async () => {
    const c = await relationCollection("many");
    const result = await run(linkOp(c.collectionId, "link", "status"), {
      row_id: c.from.id,
      target: c.targets[0] ?? "",
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("status");
    }
    expect(linkedPair).toBeNull();
  });

  test("a relation whose link type belongs to another team is refused", async () => {
    // `relationLinkTypeId` looks the type up, it never creates one — a page
    // click must not extend the team's graph schema. The old fake answered
    // every lookup with the same id, so this could not be asked.
    const collection = await fx.createCollection();
    await fx.createField({
      collectionId: collection.id,
      key: "owner",
      type: "relation",
      config: { linkTypeKey: "owned_elsewhere" },
    });
    await fx.createLinkType({
      key: "owned_elsewhere",
      fromCollectionId: collection.id,
      teamId: otherTeamId,
    });
    const from = await fx.createRecord({ collectionId: collection.id });
    const to = await fx.createRecord({ collectionId: collection.id });

    const result = await run(linkOp(collection.id, "link"), {
      row_id: from.id,
      target: to.id,
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("does not have");
    }
    expect(linkedPair).toBeNull();
  });

  test("an ORGANIZATION-level link type is usable by the team", async () => {
    // The other arm of the same OR: a type seeded for the whole organization
    // carries no teamId, and refusing it would break every seeded ontology.
    const collection = await fx.createCollection();
    await fx.createField({
      collectionId: collection.id,
      key: "owner",
      type: "relation",
      config: { linkTypeKey: "owned_org_wide" },
    });
    await fx.createLinkType({
      key: "owned_org_wide",
      fromCollectionId: collection.id,
      teamId: null,
    });
    const from = await fx.createRecord({ collectionId: collection.id });
    const to = await fx.createRecord({ collectionId: collection.id });

    const result = await run(linkOp(collection.id, "link"), {
      row_id: from.id,
      target: to.id,
    });
    expect(result.status).toBe("ok");
    expect(linkedPair).toEqual({ from: from.id, to: to.id });
  });

  test("linking FROM a row of another team is refused", async () => {
    const c = await relationCollection("many");
    const foreign = await fx.createRecord({
      collectionId: c.collectionId,
      teamId: otherTeamId,
    });
    const result = await run(linkOp(c.collectionId, "link"), {
      row_id: foreign.id,
      target: c.targets[0] ?? "",
    });
    expect(result.status).toBe("error");
    expect(linkedPair).toBeNull();
  });

  test("unlinking an edge that is not there succeeds without inventing one", async () => {
    const c = await relationCollection("many");
    const result = await run(linkOp(c.collectionId, "unlink"), {
      row_id: c.from.id,
      target: c.targets[0] ?? "",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.result).toEqual({ unlinked: 0 });
    expect(invalidatedIds).toEqual([]);
  });

  test("unlinking an edge that is already dead is not a second invalidation", async () => {
    const c = await relationCollection("many");
    await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[0] ?? "",
      validTo: new Date(),
    });
    const result = await run(linkOp(c.collectionId, "unlink"), {
      row_id: c.from.id,
      target: c.targets[0] ?? "",
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.result).toEqual({ unlinked: 0 });
    expect(invalidatedIds).toEqual([]);
  });

  test("unlinking the live edge invalidates exactly it", async () => {
    const c = await relationCollection("many");
    const live = await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[0] ?? "",
    });
    await fx.createLink({
      linkTypeId: c.linkTypeId,
      fromRecordId: c.from.id,
      toRecordId: c.targets[1] ?? "",
    });
    const result = await run(linkOp(c.collectionId, "unlink"), {
      row_id: c.from.id,
      target: c.targets[0] ?? "",
    });
    expect(result.status).toBe("ok");
    expect(invalidatedIds).toEqual([live.id]);
  });
});
