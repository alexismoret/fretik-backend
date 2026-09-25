import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { resolveAccess } from "../../../src/authz/access";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  collectionGrants,
  teamMember,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { requestAccess } from "../../../src/services/access/requests/request-access";
import { changeGrantLevel } from "../../../src/services/access/sharing/change-grant-level";
import { describeResourceAccess } from "../../../src/services/access/sharing/describe";
import { revokeGrant } from "../../../src/services/access/sharing/revoke-grant";
import { setGeneralAccess } from "../../../src/services/access/sharing/set-general-access";
import { shareResource } from "../../../src/services/access/sharing/share";
import { updateOrganizationPolicy } from "../../../src/services/access/update-organization-policy";
import { bootstrapTeamWithBotUser } from "../../../src/services/auth/bot-user";
import { reconcileTypeGrants } from "../../../src/services/collection-sharing/reconcile";
import { setTeamPolicy } from "../../../src/services/team/set-policy";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A collection shared from the same dialog as everything else. It keeps its
 * grants where the SQL tool enforces them (`collection_grants`), so the
 * dialog writes those rows, and a collection's own settings and the dialog
 * read and write one list. A collection is its team's: shared with other
 * teams or the whole organization, never one person, never restricted.
 *
 * The fixture's owner (an organization owner) and member are in the team
 * that owns the collection. `other` is a second team with one person in it.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let memberId: string;
let collectionId: string;
let otherTeamId: string;
let outsiderId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, memberId] = fx.userIds;
  otherTeamId = (await fx.createTeam()).id;
  // The settings row every team gets on creation: its policy, and the agent
  // a team's head count leaves out.
  for (const teamId of [fx.teamId, otherTeamId]) {
    // oxlint-disable-next-line no-await-in-loop -- two teams
    await bootstrapTeamWithBotUser({
      teamId,
      organizationId: fx.organizationId,
    });
  }
  outsiderId = await fx.addPerson({ inTeam: false });
  await db
    .insert(teamMember)
    .values({ userId: outsiderId, teamId: otherTeamId, createdAt: new Date() });
  collectionId = (await fx.createCollection()).id;
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

const grantsOf = async () =>
  db
    .select({
      granteeTeamId: collectionGrants.granteeTeamId,
      permission: collectionGrants.permission,
    })
    .from(collectionGrants)
    .where(eq(collectionGrants.collectionId, collectionId));

const levelOf = async (userId: string) =>
  (
    await resolveAccess(
      await fx.principalOf(userId),
      "collection",
      collectionId,
    )
  )?.level ?? null;

const share = async (
  principals: { type: "user" | "team" | "organization"; id: string }[],
  level: "view" | "edit",
  by = ownerId,
) =>
  shareResource({
    principal: await fx.principalOf(by),
    type: "collection",
    id: collectionId,
    principals,
    level,
  });

const otherTeam = () => ({ type: "team" as const, id: otherTeamId });

describe("sharing a collection from the dialog", () => {
  test("another team reads it, then edits it, then loses it, in the grants the SQL tool reads", async () => {
    const owner = await fx.principalOf(ownerId);
    expect(await levelOf(outsiderId)).toBeNull();

    const model = await share([otherTeam()], "view");
    expect(await grantsOf()).toEqual([
      { granteeTeamId: otherTeamId, permission: "read" },
    ]);
    expect(await levelOf(outsiderId)).toBe("view");
    expect(
      model.holders.map((holder) => [holder.principalId, holder.level]),
    ).toEqual([[otherTeamId, "view"]]);
    expect(model.holders[0]?.grantedBy?.userId).toBe(ownerId);
    // Nothing in the engine's own table: one list, where it is enforced.
    const engineRows = await db
      .select({ id: accessGrants.id })
      .from(accessGrants)
      .where(eq(accessGrants.resourceId, collectionId));
    expect(engineRows).toEqual([]);

    await changeGrantLevel({
      principal: owner,
      type: "collection",
      id: collectionId,
      holder: otherTeam(),
      level: "edit",
    });
    expect(await grantsOf()).toEqual([
      { granteeTeamId: otherTeamId, permission: "write" },
    ]);
    expect(await levelOf(outsiderId)).toBe("edit");

    await revokeGrant({
      principal: owner,
      type: "collection",
      id: collectionId,
      holder: otherTeam(),
    });
    expect(await grantsOf()).toEqual([]);
    expect(await levelOf(outsiderId)).toBeNull();

    const journal = await db
      .select({ action: accessAuditLog.action })
      .from(accessAuditLog)
      .where(
        and(
          eq(accessAuditLog.organizationId, fx.organizationId),
          eq(accessAuditLog.resourceId, collectionId),
        ),
      );
    expect(journal.map((entry) => entry.action).sort()).toEqual([
      "grant.created",
      "grant.removed",
      "grant.updated",
    ]);
  });

  test("with the whole organization, beside a team", async () => {
    await share([otherTeam()], "edit");
    await share([{ type: "organization", id: fx.organizationId }], "view");

    expect(
      (await grantsOf()).sort((a, b) =>
        String(a.granteeTeamId).localeCompare(String(b.granteeTeamId)),
      ),
    ).toEqual(
      [
        { granteeTeamId: otherTeamId, permission: "write" as const },
        { granteeTeamId: null, permission: "read" as const },
      ].sort((a, b) =>
        String(a.granteeTeamId).localeCompare(String(b.granteeTeamId)),
      ),
    );
    // The most a person gets: the team's edit over the organization's view.
    expect(await levelOf(outsiderId)).toBe("edit");
  });

  test("the dialog and the collection's own settings read and write one list", async () => {
    await db.transaction((tx) =>
      reconcileTypeGrants({
        collectionId,
        ownerTeamId: fx.teamId,
        organizationId: fx.organizationId,
        audience: {
          mode: "teams",
          teams: [{ teamId: otherTeamId, permission: "write" }],
        },
        createdByUserId: ownerId,
        tx,
      }),
    );

    const model = await describeResourceAccess({
      principal: await fx.principalOf(ownerId),
      type: "collection",
      id: collectionId,
    });
    expect(
      model.holders.map((holder) => [holder.principalType, holder.level]),
    ).toEqual([["team", "edit"]]);
    expect(model.general).toMatchObject({
      restricted: false,
      restrictable: false,
      inheritsFrom: { type: "team", id: fx.teamId },
    });
    expect(model.offeredLevels).toEqual(["view", "edit"]);
    expect(model.shareablePrincipals).toEqual(["team", "organization"]);
  });
});

describe("what a collection is never given", () => {
  test("one person, or its own team", async () => {
    expect(
      await refusal(share([{ type: "user", id: outsiderId }], "view")),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(
      await refusal(share([{ type: "team", id: fx.teamId }], "view")),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(await grantsOf()).toEqual([]);
  });

  test("a restriction: it is always its team's", async () => {
    expect(
      await refusal(
        setGeneralAccess({
          principal: await fx.principalOf(ownerId),
          type: "collection",
          id: collectionId,
          restricted: true,
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("a request from one person, and no refusal offers one", async () => {
    await share([otherTeam()], "view");
    const reader = await fx.principalOf(outsiderId);

    expect(
      await refusal(
        requestAccess({
          principal: reader,
          type: "collection",
          id: collectionId,
          level: "edit",
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    const refused = await rejection(
      shareResource({
        principal: reader,
        type: "collection",
        id: collectionId,
        principals: [{ type: "organization", id: fx.organizationId }],
        level: "view",
      }),
    );
    expect(parseApiError((refused as HTTPException).message)).toMatchObject({
      code: "ACCESS_DENIED",
      access: { requestable: false },
    });
  });
});

describe("who shares it", () => {
  test("with members at edit, a lead of its team, not a member", async () => {
    await setTeamPolicy({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      patch: { memberContentLevel: "edit" },
    });

    expect(await refusal(share([otherTeam()], "view", memberId))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
  });

  test("within the organization's sharing policies", async () => {
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { crossTeamSharing: false, organizationSharing: false },
    });

    expect(await refusal(share([otherTeam()], "view"))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(
      await refusal(
        share([{ type: "organization", id: fx.organizationId }], "view"),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });
});
