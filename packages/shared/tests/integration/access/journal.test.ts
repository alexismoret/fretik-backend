import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import type { AccessJournalQuery } from "../../../src/schemas/access-journal";
import { parseApiError } from "../../../src/schemas/errors";
import { listAccessJournal } from "../../../src/services/access/journal/list-journal";
import {
  recordAccessEvent,
  recordAccessEvents,
} from "../../../src/services/access/record-event";
import { shareResource } from "../../../src/services/access/sharing/share";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * The access journal as the organization's admins read it
 * (`services/access/journal/list-journal.ts`): who reads it, what it names,
 * and how it pages. What each change writes is tested with the change.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
});

afterEach(async () => {
  await fx.cleanup();
});

const read = async (userId: string, query: Partial<AccessJournalQuery> = {}) =>
  listAccessJournal({
    principal: await fx.principalOf(userId),
    query: { limit: 50, ...query },
  });

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

/** One entry of this workspace, as the team's creation writes it. */
const teamCreated = (name: string) => ({
  organizationId: fx.organizationId,
  actorUserId: ownerId,
  action: "team.created" as const,
  principal: { type: "team" as const, id: fx.teamId },
  metadata: { teamName: name },
});

describe("who reads it", () => {
  test("the organization's admins, and nobody else", async () => {
    await recordAccessEvent(teamCreated("Sales"));
    const adminId = await fx.addPerson({ role: "admin" });
    const guestId = await fx.addPerson({ role: "guest" });

    expect((await read(ownerId)).entries.map((e) => e.action)).toEqual([
      "team.created",
    ]);
    expect((await read(adminId)).entries).toHaveLength(1);
    expect((await refusal(read(memberId))).status).toBe(403);
    expect((await refusal(read(guestId))).status).toBe(403);
  });

  test("holds this organization's changes alone", async () => {
    const other = await createWorkspaceFixture();
    try {
      await recordAccessEvent({
        ...teamCreated("Elsewhere"),
        organizationId: other.organizationId,
        actorUserId: other.userIds[0],
      });
      await recordAccessEvent(teamCreated("Here"));

      const { entries } = await read(ownerId);
      expect(entries.map((e) => e.principal?.name)).toEqual(["Here"]);
    } finally {
      await other.cleanup();
    }
  });
});

describe("what it names", () => {
  test("an item only to a reader who can open it now", async () => {
    // Tester B keeps a page to themselves, and shares it with a colleague.
    const kept = await fx.createPage({
      name: "Salary review",
      createdByUserId: memberId,
      ownerUserId: memberId,
      userId: memberId,
      accessRestricted: true,
    });
    const colleague = await fx.addPerson();
    await shareResource({
      principal: await fx.principalOf(memberId),
      type: "page",
      id: kept.id,
      principals: [{ type: "user", id: colleague }],
      level: "view",
    });
    // A page open to the team, shared by its owner.
    const open = await fx.createPage({ name: "Team handbook" });
    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "page",
      id: open.id,
      principals: [{ type: "user", id: colleague }],
      level: "edit",
    });

    const { entries } = await read(ownerId, { category: "sharing" });
    const about = (id: string) => entries.find((e) => e.resource?.id === id);
    // Who shared something with whom is there for the admins; which private
    // page, only for whoever can open it.
    expect(about(kept.id)).toMatchObject({
      action: "grant.created",
      actor: { userId: memberId },
      resource: { type: "page", name: null },
      principal: { type: "user", id: colleague },
      details: { level: "view" },
    });
    expect(typeof about(kept.id)?.principal?.name).toBe("string");
    expect(about(open.id)?.resource?.name).toBe("Team handbook");
    // Its owner reads the journal no better: the journal is not theirs.
    expect((await refusal(read(memberId))).status).toBe(403);
  });

  test("a person by the name recorded, and one recorded without a name by today's", async () => {
    await recordAccessEvents(db, [
      {
        organizationId: fx.organizationId,
        actorUserId: ownerId,
        action: "member.role_changed",
        principal: { type: "user", id: memberId },
        metadata: {
          userName: "Before the rename",
          from: "member",
          to: "admin",
        },
      },
      {
        organizationId: fx.organizationId,
        actorUserId: memberId,
        action: "request.created",
        principal: { type: "user", id: memberId },
        metadata: { level: "edit" },
      },
    ]);

    const { entries } = await read(ownerId);
    const of = (action: string) => entries.find((e) => e.action === action);
    expect(of("member.role_changed")).toMatchObject({
      principal: { name: "Before the rename" },
      details: { from: "member", to: "admin" },
    });
    expect(of("request.created")?.principal?.name).toStartWith("Tester B");
  });
});

describe("paging and filters", () => {
  test("pages from newest to oldest, with nothing skipped or repeated", async () => {
    // Four written together share one instant; the cursor still tells them apart.
    await recordAccessEvents(
      db,
      ["A", "B", "C", "D"].map((name) => teamCreated(name)),
    );
    await recordAccessEvent(teamCreated("E"));

    const all = (await read(ownerId)).entries.map((e) => e.id);
    expect(all).toHaveLength(5);
    const paged: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      // eslint-disable-next-line no-await-in-loop -- each page starts where the last stopped
      const next = await read(ownerId, { limit: 2, cursor });
      paged.push(...next.entries.map((e) => e.id));
      if (next.nextCursor === null) break;
      cursor = next.nextCursor;
    }
    expect(paged).toEqual(all);
    expect((await read(ownerId)).entries[0]?.principal?.name).toBe("E");
  });

  test("by kind of change, and by the person who made it or whom it was about", async () => {
    await recordAccessEvent(teamCreated("Sales"));
    await recordAccessEvent({
      organizationId: fx.organizationId,
      actorUserId: ownerId,
      action: "member.role_changed",
      principal: { type: "user", id: memberId },
      metadata: { from: "member", to: "admin" },
    });
    const page = await fx.createPage();
    await recordAccessEvent({
      organizationId: fx.organizationId,
      actorUserId: memberId,
      action: "grant.created",
      resource: { type: "page", id: page.id },
      principal: { type: "team", id: fx.teamId },
      metadata: { level: "view" },
    });

    const actions = async (query: Partial<AccessJournalQuery>) =>
      (await read(ownerId, query)).entries.map((e) => e.action);
    expect(await actions({ category: "teams" })).toEqual(["team.created"]);
    expect(await actions({ category: "people" })).toEqual([
      "member.role_changed",
    ]);
    expect(await actions({ userId: memberId })).toEqual([
      "grant.created",
      "member.role_changed",
    ]);
  });

  test("refuses a cursor it did not give", async () => {
    expect(
      (await refusal(read(ownerId, { cursor: "not-a-cursor" }))).status,
    ).toBe(400);
  });
});
