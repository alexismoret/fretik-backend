import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import {
  collectionRecords,
  toolApprovalRequests,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { updateOrganizationPolicy } from "../../../src/services/access/update-organization-policy";
import { executeRecordWriteApproval } from "../../../src/services/approvals/execute-record-write";
import { bootstrapTeamWithBotUser } from "../../../src/services/auth/bot-user";
import { beginApiLoad } from "../../../src/services/bulk-operations/api-load";
import { writableIds } from "../../../src/services/bulk-operations/executors/writable-ids";
import { requireCollectionAudienceAllowed } from "../../../src/services/collection-sharing/audience-policy";
import {
  assertCanDeleteRecords,
  assertCanManageType,
  assertCanShareRecord,
  RECORD_DELETION_REFUSAL,
} from "../../../src/services/collection-sharing/write-access";
import { setTeamPolicy } from "../../../src/services/team/set-policy";
import { setTeamMemberRole } from "../../../src/services/team/set-role";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * What the team's policy holds back from its members (`memberContentLevel`):
 * at `edit`, deleting and sharing stay with the team's leads and each item's
 * author. Collections are not engine resources with levels of their own, so
 * their doors ask the person's level on the team's content — the API, the
 * assistant's tools, the code-mode SDK, approvals and streamed loads.
 *
 * The workspace's owner leads its team (an organization owner manages every
 * team, but their role in one still sets their access to its content); the
 * member is a member. Each refusal is paired with the same call for someone
 * it allows, so it cannot be a door that refuses everyone.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let collectionId: string;
let membersRecord: string;
let ownersRecord: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  // The settings row every team gets on creation, which holds its policy.
  await bootstrapTeamWithBotUser({
    teamId: fx.teamId,
    organizationId: fx.organizationId,
  });
  await setTeamMemberRole({
    principal: await fx.principalOf(ownerId),
    teamId: fx.teamId,
    userId: ownerId,
    role: "lead",
  });
  collectionId = (await fx.createCollection()).id;
  membersRecord = (
    await fx.createRecord({ collectionId, createdByUserId: memberId })
  ).id;
  ownersRecord = (
    await fx.createRecord({ collectionId, createdByUserId: ownerId })
  ).id;
});

afterEach(async () => {
  await fx.cleanup();
});

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

const DENIED = { status: 403, code: "ACCESS_DENIED" };

const scopeOf = (userId: string | undefined) => ({
  teamId: fx.teamId,
  organizationId: fx.organizationId,
  userId,
});

const membersAtEdit = async () => {
  await setTeamPolicy({
    principal: await fx.principalOf(ownerId),
    teamId: fx.teamId,
    patch: { memberContentLevel: "edit" },
  });
};

describe("deleting records", () => {
  test("at edit, a member deletes the records they created, and a lead any", async () => {
    await membersAtEdit();

    await assertCanDeleteRecords({
      recordIds: [membersRecord],
      ...scopeOf(memberId),
    });
    expect(
      await refusal(
        assertCanDeleteRecords({
          recordIds: [membersRecord, ownersRecord],
          ...scopeOf(memberId),
        }),
      ),
    ).toEqual(DENIED);
    await assertCanDeleteRecords({
      recordIds: [membersRecord, ownersRecord],
      ...scopeOf(ownerId),
    });
    // No person behind the delete: the team acting for itself.
    await assertCanDeleteRecords({
      recordIds: [ownersRecord],
      ...scopeOf(undefined),
    });
  });

  test("under the default policy, members delete any of the team's records", async () => {
    await assertCanDeleteRecords({
      recordIds: [membersRecord, ownersRecord],
      ...scopeOf(memberId),
    });
  });

  test("a streamed delete spares the records someone else created", async () => {
    await membersAtEdit();
    const { operation } = await beginApiLoad({
      op: "delete",
      collectionId,
      totalRows: 2,
      rowsDigest: "0123456789abcdef-delete",
      sample: [],
      ...scopeOf(memberId),
      userId: memberId,
    });

    const { writable, refused } = await writableIds(operation, [
      membersRecord,
      ownersRecord,
    ]);

    expect([...writable]).toEqual([membersRecord]);
    expect(refused.get(ownersRecord)).toBe(RECORD_DELETION_REFUSAL);
  });

  test("an approval granted to delete them deletes only the requester's own", async () => {
    await membersAtEdit();
    const conversationId = (await fx.createConversation()).id;
    const [approval] = await db
      .insert(toolApprovalRequests)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: memberId,
        conversationId,
        turnId: crypto.randomUUID(),
        kind: "record_write",
        lookupHash: `hash-${crypto.randomUUID()}`,
        status: "executing",
        payload: {
          op: "delete",
          items: [{ recordId: membersRecord }, { recordId: ownersRecord }],
        },
      })
      .returning();
    if (!approval) throw new Error("fixture: no approval");

    const result = await executeRecordWriteApproval({ approval });

    expect(result).toEqual([
      { ok: true, id: membersRecord, label: "" },
      { ok: false, error: RECORD_DELETION_REFUSAL },
    ]);
    const left = await db
      .select({ id: collectionRecords.id })
      .from(collectionRecords)
      .where(eq(collectionRecords.collectionId, collectionId));
    expect(left.map((row) => row.id)).toEqual([ownersRecord]);
  });
});

describe("a streamed load", () => {
  test("a viewer starts none, and one who becomes a viewer writes nothing more", async () => {
    const load = (userId: string) =>
      beginApiLoad({
        op: "update",
        collectionId,
        totalRows: 1,
        rowsDigest: `0123456789abcdef-${userId}`,
        sample: [],
        ...scopeOf(userId),
        userId,
      });
    const { operation } = await load(memberId);
    await setTeamMemberRole({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      userId: memberId,
      role: "viewer",
    });

    expect(await refusal(load(memberId))).toEqual(DENIED);
    const { writable, refused } = await writableIds(operation, [membersRecord]);
    expect(writable.size).toBe(0);
    expect(refused.get(membersRecord)).toContain("no longer change");
  });
});

describe("a collection", () => {
  test("at edit, a member renames it, but only a lead shares or deletes it", async () => {
    await membersAtEdit();
    const manage = (userId: string, change: "details" | "sharing" | "delete") =>
      assertCanManageType({ collectionId, ...scopeOf(userId), change });

    await manage(memberId, "details");
    expect(await refusal(manage(memberId, "sharing"))).toEqual(DENIED);
    expect(await refusal(manage(memberId, "delete"))).toEqual(DENIED);
    await manage(ownerId, "sharing");
    await manage(ownerId, "delete");
  });

  test("at edit, a record's sharing is its author's to change, or a lead's", async () => {
    await membersAtEdit();

    await assertCanShareRecord({
      recordId: membersRecord,
      ...scopeOf(memberId),
    });
    expect(
      await refusal(
        assertCanShareRecord({ recordId: ownersRecord, ...scopeOf(memberId) }),
      ),
    ).toEqual(DENIED);
    await assertCanShareRecord({ recordId: ownersRecord, ...scopeOf(ownerId) });
  });

  test("its audience stays within the organization's sharing policies", async () => {
    const other = await fx.createTeam();
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { crossTeamSharing: false, organizationSharing: false },
    });
    const audience = (
      sharing: Parameters<
        typeof requireCollectionAudienceAllowed
      >[0]["sharing"],
    ) => requireCollectionAudienceAllowed({ ...scopeOf(memberId), sharing });

    expect(
      await refusal(
        audience({
          mode: "teams",
          teams: [{ teamId: other.id, permission: "read" }],
        }),
      ),
    ).toEqual(DENIED);
    expect(
      await refusal(audience({ mode: "org", permission: "read" })),
    ).toEqual(DENIED);
    await audience({ mode: "internal" });
  });
});
