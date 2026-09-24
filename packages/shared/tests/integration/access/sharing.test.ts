import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { resolveAccess } from "../../../src/authz/access";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  aiVectors,
  documents,
  folders,
  workflows,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { changeGrantLevel } from "../../../src/services/access/sharing/change-grant-level";
import { describeResourceAccess } from "../../../src/services/access/sharing/describe";
import { revokeGrant } from "../../../src/services/access/sharing/revoke-grant";
import { setGeneralAccess } from "../../../src/services/access/sharing/set-general-access";
import { shareResource } from "../../../src/services/access/sharing/share";
import { updateOrganizationPolicy } from "../../../src/services/access/update-organization-policy";
import { setTeamMemberRole } from "../../../src/services/team/set-role";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * Sharing one resource through the engine's grants — what the share dialog
 * reads and changes — and the assistant's search index moving with it in the
 * same transaction (`acl_principals`).
 *
 * The workspace has an owner (an organization owner, so an admin) and a
 * member, both in the team. Under the default team policy a member has full
 * access to the team's content, so both may share it; the tests that need a
 * weaker person make the member a viewer.
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

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

const journal = async (action: string) =>
  db
    .select()
    .from(accessAuditLog)
    .where(
      and(
        eq(accessAuditLog.organizationId, fx.organizationId),
        eq(accessAuditLog.action, action),
      ),
    );

const insertFolder = async (
  input: { ownerUserId?: string; parentFolderId?: string } = {},
): Promise<string> => {
  const name = `folder-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(folders)
    .values({
      teamId: fx.teamId,
      name,
      parentFolderId: input.parentFolderId ?? null,
      fullPath: `/${name}`,
      ownerUserId: input.ownerUserId ?? ownerId,
      createdById: input.ownerUserId ?? ownerId,
    })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: no folder");
  return row.id;
};

const insertDocument = async (
  input: { ownerUserId?: string | null; folderId?: string } = {},
): Promise<string> => {
  const owner = input.ownerUserId === undefined ? ownerId : input.ownerUserId;
  const [row] = await db
    .insert(documents)
    .values({
      teamId: fx.teamId,
      folderId: input.folderId ?? null,
      status: "ready",
      originalFilename: `file-${randomUUID().slice(0, 8)}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
      ownerUserId: owner,
      uploadedById: owner,
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: no document");
  // One chunk in the assistant's index, to watch its audience move.
  await db.insert(aiVectors).values({
    sourceType: "documents",
    sourceId: row.id,
    teamId: fx.teamId,
    organizationId: fx.organizationId,
    content: "a chunk",
    contextualPrefix: "",
    chunkIndex: 0,
    totalChunks: 1,
    metadata: {
      file_name: "file.pdf",
      file_type: "application/pdf",
      page_count: 1,
      document_language: null,
      document_summary: null,
      entities: [],
      custom_fields: {},
    },
  });
  return row.id;
};

const insertWorkflow = async (owner: string): Promise<string> => {
  const [row] = await db
    .insert(workflows)
    .values({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      ownerUserId: owner,
      createdByUserId: owner,
      name: `workflow-${randomUUID().slice(0, 8)}`,
      triggerType: "manual",
      playbook: {
        goal: "hold access facts",
        tasks: [{ key: "t", title: "T", description: "", instructions: "i" }],
      },
    })
    .returning({ id: workflows.id });
  if (!row) throw new Error("fixture: no workflow");
  return row.id;
};

/** The audience the assistant's search keeps for a document's chunks. */
const aclOf = async (documentId: string) => {
  const [row] = await db
    .select({ acl: aiVectors.aclPrincipals })
    .from(aiVectors)
    .where(
      and(
        eq(aiVectors.sourceType, "documents"),
        eq(aiVectors.sourceId, documentId),
      ),
    );
  return row?.acl === null || row?.acl === undefined
    ? row?.acl
    : [...row.acl].sort();
};

const sorted = (ids: string[]) => [...ids].sort();

const levelOf = async (
  userId: string,
  type: "document" | "folder",
  id: string,
) =>
  (await resolveAccess(await fx.principalOf(userId), type, id))?.level ?? null;

describe("the share dialog's model", () => {
  test("a teammate reads who has access: the owner, inherited from the team", async () => {
    const doc = await insertDocument();
    const model = await describeResourceAccess({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
    });
    expect(model.owner?.userId).toBe(ownerId);
    expect(model.holders).toEqual([]);
    expect(model.general).toMatchObject({
      restricted: false,
      inheritsFrom: { type: "team", id: fx.teamId },
      ownerRestrictsOnly: false,
    });
    expect(model.offeredLevels).toEqual(["view", "edit", "full"]);
    expect(model.ceilings).toEqual({
      team: "full",
      outsider: "full",
      insiders: null,
    });
    expect(model.canManage).toBe(true);
  });

  test("a document in a folder inherits from the folder", async () => {
    const folderId = await insertFolder();
    const doc = await insertDocument({ folderId });
    const model = await describeResourceAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
    });
    expect(model.general.inheritsFrom).toMatchObject({
      type: "folder",
      id: folderId,
    });
  });
});

describe("restricting", () => {
  test("a restricted document leaves the team, and the search index with it", async () => {
    const doc = await insertDocument();
    const model = await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
      restricted: true,
    });

    expect(model.general.restricted).toBe(true);
    expect(await levelOf(memberId, "document", doc)).toBeNull();
    expect(await levelOf(ownerId, "document", doc)).toBe("full");
    expect(await aclOf(doc)).toEqual([ownerId]);
    const [entry] = await journal("restriction.changed");
    expect(entry?.metadata).toMatchObject({ restricted: true });

    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
      restricted: false,
    });
    expect(await levelOf(memberId, "document", doc)).toBe("full");
    // Back to its team's scope, which the rows' team already says.
    expect(await aclOf(doc)).toBeNull();
  });

  test("a teammate who restricts someone else's document keeps it through a grant", async () => {
    const doc = await insertDocument();
    const model = await setGeneralAccess({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      restricted: true,
    });
    expect(
      model.holders.map((h) => [h.principalType, h.principalId, h.level]),
    ).toEqual([["user", memberId, "full"]]);
    expect(await levelOf(memberId, "document", doc)).toBe("full");
    expect(await aclOf(doc)).toEqual(sorted([ownerId, memberId]));
  });

  test("a restricted folder hides what is below it, from the search index too", async () => {
    const folderId = await insertFolder();
    const doc = await insertDocument({ folderId });
    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "folder",
      id: folderId,
      restricted: true,
    });
    expect(await levelOf(memberId, "document", doc)).toBeNull();
    expect(await aclOf(doc)).toEqual([ownerId]);
  });

  test("only its owner restricts a workflow: restricted, it runs with their access", async () => {
    const workflowId = await insertWorkflow(ownerId);
    expect(
      await refusal(
        setGeneralAccess({
          principal: await fx.principalOf(memberId),
          type: "workflow",
          id: workflowId,
          restricted: true,
        }),
      ),
    ).toMatchObject({ status: 403 });

    const model = await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "workflow",
      id: workflowId,
      restricted: true,
    });
    expect(model.general).toMatchObject({
      restricted: true,
      ownerRestrictsOnly: true,
    });
    // Restricted, it runs as its owner: nobody else can be given more.
    expect(model.ceilings).toEqual({
      team: "view",
      outsider: "view",
      insiders: null,
    });
    const row = await db.query.workflows.findFirst({
      columns: { userId: true, accessRestricted: true },
      where: { id: workflowId },
    });
    // The legacy column says the same, for code that predates the engine.
    expect(row).toEqual({ userId: ownerId, accessRestricted: true });
  });
});

describe("sharing", () => {
  test("sharing a restricted document gives the level, and the search index", async () => {
    const doc = await insertDocument();
    const owner = await fx.principalOf(ownerId);
    await setGeneralAccess({
      principal: owner,
      type: "document",
      id: doc,
      restricted: true,
    });

    const model = await shareResource({
      principal: owner,
      type: "document",
      id: doc,
      principals: [{ type: "user", id: memberId }],
      level: "view",
    });

    expect(
      model.holders.map((h) => [h.principalId, h.level, h.grantedBy?.userId]),
    ).toEqual([[memberId, "view", ownerId]]);
    expect(await levelOf(memberId, "document", doc)).toBe("view");
    expect(await aclOf(doc)).toEqual(sorted([ownerId, memberId]));
    const [entry] = await journal("grant.created");
    expect(entry).toMatchObject({
      principalType: "user",
      principalId: memberId,
      resourceType: "document",
      resourceId: doc,
    });
    expect(entry?.metadata).toMatchObject({ level: "view" });
  });

  test("the owner is never given a grant: they have full access already", async () => {
    const doc = await insertDocument();
    const model = await shareResource({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      principals: [{ type: "user", id: ownerId }],
      level: "view",
    });
    expect(model.holders).toEqual([]);
  });

  test("a level the type does not offer is refused", async () => {
    const folderId = await insertFolder();
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(ownerId),
          type: "folder",
          id: folderId,
          principals: [{ type: "user", id: memberId }],
          level: "use",
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("someone outside the organization is refused", async () => {
    const doc = await insertDocument();
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(ownerId),
          type: "document",
          id: doc,
          principals: [{ type: "user", id: randomUUID() }],
          level: "view",
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("a viewer cannot share: sharing takes full access", async () => {
    const doc = await insertDocument();
    await setTeamMemberRole({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      userId: memberId,
      role: "viewer",
    });
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(memberId),
          type: "document",
          id: doc,
          principals: [{ type: "user", id: ownerId }],
          level: "view",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });

  test("sharing beyond the team follows the policy, which stops new shares only", async () => {
    const doc = await insertDocument();
    const other = await fx.createTeam();
    const owner = await fx.principalOf(ownerId);
    await updateOrganizationPolicy({
      principal: owner,
      patch: { crossTeamSharing: false },
    });
    // An admin is refused too: the policy is the organization's rule.
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(memberId),
          type: "document",
          id: doc,
          principals: [{ type: "team", id: other.id }],
          level: "view",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });

    await updateOrganizationPolicy({
      principal: owner,
      patch: { crossTeamSharing: true },
    });
    await shareResource({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      principals: [{ type: "team", id: other.id }],
      level: "view",
    });

    // Turned off again: the share stays, and its level can still change.
    await updateOrganizationPolicy({
      principal: owner,
      patch: { crossTeamSharing: false },
    });
    const model = await changeGrantLevel({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      holder: { type: "team", id: other.id },
      level: "edit",
    });
    expect(model.holders.map((h) => [h.principalId, h.level])).toEqual([
      [other.id, "edit"],
    ]);
  });

  test("sharing with the whole organization follows its own policy", async () => {
    const doc = await insertDocument();
    await updateOrganizationPolicy({
      principal: await fx.principalOf(ownerId),
      patch: { organizationSharing: false },
    });
    expect(
      await refusal(
        shareResource({
          principal: await fx.principalOf(memberId),
          type: "document",
          id: doc,
          principals: [{ type: "organization", id: fx.organizationId }],
          level: "view",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
  });
});

describe("changing and removing access", () => {
  test("changing a level journals the level before and after", async () => {
    const doc = await insertDocument();
    const owner = await fx.principalOf(ownerId);
    const other = await fx.createTeam();
    await shareResource({
      principal: owner,
      type: "document",
      id: doc,
      principals: [{ type: "team", id: other.id }],
      level: "view",
    });
    await changeGrantLevel({
      principal: owner,
      type: "document",
      id: doc,
      holder: { type: "team", id: other.id },
      level: "full",
    });
    const [entry] = await journal("grant.updated");
    expect(entry?.metadata).toMatchObject({
      level: "full",
      previousLevel: "view",
    });
  });

  test("revoking takes the access away, and the search index follows", async () => {
    const doc = await insertDocument();
    const owner = await fx.principalOf(ownerId);
    await setGeneralAccess({
      principal: owner,
      type: "document",
      id: doc,
      restricted: true,
    });
    await shareResource({
      principal: owner,
      type: "document",
      id: doc,
      principals: [{ type: "user", id: memberId }],
      level: "edit",
    });

    const model = await revokeGrant({
      principal: owner,
      type: "document",
      id: doc,
      holder: { type: "user", id: memberId },
    });
    expect(model?.holders).toEqual([]);
    expect(await levelOf(memberId, "document", doc)).toBeNull();
    expect(await aclOf(doc)).toEqual([ownerId]);
    const [entry] = await journal("grant.removed");
    expect(entry?.metadata).toMatchObject({ previousLevel: "edit" });
  });

  test("removing one's own access to a restricted item answers null", async () => {
    const doc = await insertDocument();
    // The member restricts the owner's document and keeps it through a grant.
    await setGeneralAccess({
      principal: await fx.principalOf(memberId),
      type: "document",
      id: doc,
      restricted: true,
    });
    expect(
      await revokeGrant({
        principal: await fx.principalOf(memberId),
        type: "document",
        id: doc,
        holder: { type: "user", id: memberId },
      }),
    ).toBeNull();
  });

  test("a restricted item whose owner is gone keeps someone with full access", async () => {
    const doc = await insertDocument({ ownerUserId: null });
    const member = await fx.principalOf(memberId);
    await setGeneralAccess({
      principal: member,
      type: "document",
      id: doc,
      restricted: true,
    });
    // The member is the only one left with full access.
    expect(
      await refusal(
        revokeGrant({
          principal: member,
          type: "document",
          id: doc,
          holder: { type: "user", id: memberId },
        }),
      ),
    ).toEqual({ status: 409, code: "LAST_FULL_ACCESS" });
    expect(
      await refusal(
        changeGrantLevel({
          principal: member,
          type: "document",
          id: doc,
          holder: { type: "user", id: memberId },
          level: "edit",
        }),
      ),
    ).toEqual({ status: 409, code: "LAST_FULL_ACCESS" });
    const grants = await db
      .select({ level: accessGrants.level })
      .from(accessGrants)
      .where(eq(accessGrants.resourceId, doc));
    expect(grants).toEqual([{ level: "full" }]);
  });
});
