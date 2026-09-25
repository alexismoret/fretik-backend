import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import {
  accessAuditLog,
  accessGrants,
  accessRequests,
  documents,
  member,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Asking for more access, and answering: a request is made from what one can
 * already see, reaches the people who hold full access to it, and is closed
 * by their answer — or by a share that gives what it asked for.
 *
 * The workspace has an owner (an organization owner, so an admin) and a
 * member made a viewer of the team, who sees the team's content and can do
 * nothing more with it. The only double is the email transport: who was
 * written to, and about what.
 */

const sent: { to: string; subject: string }[] = [];

await mockModule("../../src/lib/email", {
  sendEmail: (options: { to: { email: string }; subject: string }) => {
    sent.push({ to: options.to.email, subject: options.subject });
    return Promise.resolve();
  },
});

const { resolveAccess } = await import("../../../src/authz/access");
const { bumpAccessVersion } = await import("../../../src/authz/load-principal");
const { requestAccess } =
  await import("../../../src/services/access/requests/request-access");
const { listAccessRequests } =
  await import("../../../src/services/access/requests/list-requests");
const { cancelAccessRequest, decideAccessRequest } =
  await import("../../../src/services/access/requests/decide-request");
const { describeResourceAccess } =
  await import("../../../src/services/access/sharing/describe");
const { setGeneralAccess } =
  await import("../../../src/services/access/sharing/set-general-access");
const { shareResource } =
  await import("../../../src/services/access/sharing/share");
const { changeGrantLevel } =
  await import("../../../src/services/access/sharing/change-grant-level");
const { setTeamMemberRole } =
  await import("../../../src/services/team/set-role");

let fx: WorkspaceFixture;
let ownerId: string;
let viewerId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId, viewerId] = fx.userIds;
  await setTeamMemberRole({
    principal: await fx.principalOf(ownerId),
    teamId: fx.teamId,
    userId: viewerId,
    role: "viewer",
  });
  sent.length = 0;
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

const insertDocument = async (): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId: fx.teamId,
      status: "ready",
      originalFilename: `file-${randomUUID().slice(0, 8)}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
      ownerUserId: ownerId,
      uploadedById: ownerId,
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: no document");
  return row.id;
};

const emailOf = async (userId: string): Promise<string> => {
  const row = await db.query.user.findFirst({
    columns: { email: true },
    where: { id: userId },
  });
  if (!row) throw new Error("fixture: no such person");
  return row.email;
};

const levelOf = async (userId: string, id: string) =>
  (await resolveAccess(await fx.principalOf(userId), "document", id))?.level ??
  null;

const requestsOn = async (id: string) =>
  db
    .select({
      id: accessRequests.id,
      status: accessRequests.status,
      level: accessRequests.requestedLevel,
      message: accessRequests.message,
      decidedBy: accessRequests.decidedByUserId,
    })
    .from(accessRequests)
    .where(eq(accessRequests.resourceId, id));

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

/** The viewer asks for edit access to a new document of the owner's. */
const askForEdit = async (message?: string) => {
  const doc = await insertDocument();
  const request = await requestAccess({
    principal: await fx.principalOf(viewerId),
    type: "document",
    id: doc,
    level: "edit",
    message,
  });
  sent.length = 0;
  return { doc, request };
};

describe("asking", () => {
  test("a viewer asks for more: one pending request, journaled, and the owner is told", async () => {
    const doc = await insertDocument();
    const request = await requestAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
      level: "edit",
      message: "  To fix the totals  ",
    });

    expect(request).toMatchObject({
      resource: { type: "document", id: doc },
      requester: { userId: viewerId },
      level: "edit",
      currentLevel: "view",
      message: "To fix the totals",
      status: "pending",
      decidedAt: null,
      decidedBy: null,
    });
    expect(await requestsOn(doc)).toEqual([
      {
        id: request.id,
        status: "pending",
        level: "edit",
        message: "To fix the totals",
        decidedBy: null,
      },
    ]);
    const [entry] = await journal("request.created");
    expect(entry).toMatchObject({
      actorUserId: viewerId,
      resourceType: "document",
      resourceId: doc,
    });
    expect(sent.map((email) => email.to)).toEqual([await emailOf(ownerId)]);
  });

  test("asking again while the request waits updates it", async () => {
    const { doc, request } = await askForEdit("first");
    const again = await requestAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
      level: "full",
      message: "second",
    });

    expect(again.id).toBe(request.id);
    expect(await requestsOn(doc)).toEqual([
      {
        id: request.id,
        status: "pending",
        level: "full",
        message: "second",
        decidedBy: null,
      },
    ]);
  });

  test("a resource one cannot see answers as missing: a request would say it exists", async () => {
    const doc = await insertDocument();
    await setGeneralAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
      restricted: true,
    });

    expect(
      await refusal(
        requestAccess({
          principal: await fx.principalOf(viewerId),
          type: "document",
          id: doc,
          level: "view",
        }),
      ),
    ).toMatchObject({ status: 404 });
    expect(await requestsOn(doc)).toEqual([]);
    expect(sent).toEqual([]);
  });

  test("asking for what one has, or for a level the type does not offer, is refused", async () => {
    const doc = await insertDocument();
    const viewer = await fx.principalOf(viewerId);

    expect(
      await refusal(
        requestAccess({
          principal: viewer,
          type: "document",
          id: doc,
          level: "view",
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(
      await refusal(
        requestAccess({
          principal: viewer,
          type: "document",
          id: doc,
          level: "use",
        }),
      ),
    ).toMatchObject({ status: 400 });
    expect(await requestsOn(doc)).toEqual([]);
  });

  test("a guest receives what is shared with them, and does not ask", async () => {
    const doc = await insertDocument();
    const guestId = await fx.addPerson({ inTeam: false });
    await db
      .update(member)
      .set({ role: "guest" })
      .where(
        and(
          eq(member.userId, guestId),
          eq(member.organizationId, fx.organizationId),
        ),
      );
    // The share dialog does not offer guests yet: the grant is written as
    // the door that brings a guest in to one item will write it.
    await db.insert(accessGrants).values({
      organizationId: fx.organizationId,
      resourceType: "document",
      resourceId: doc,
      principalType: "user",
      principalId: guestId,
      level: "view",
      grantedByUserId: ownerId,
    });
    expect(await levelOf(guestId, doc)).toBe("view");

    expect(
      await refusal(
        requestAccess({
          principal: await fx.principalOf(guestId),
          type: "document",
          id: doc,
          level: "edit",
        }),
      ),
    ).toMatchObject({ status: 403 });
    expect(await requestsOn(doc)).toEqual([]);
  });
});

describe("listing", () => {
  test("the owner has the request to answer; the requester has it as their own", async () => {
    const { request } = await askForEdit();

    const owners = await listAccessRequests(await fx.principalOf(ownerId));
    expect(owners.toDecide.map((r) => r.id)).toEqual([request.id]);
    expect(owners.mine).toEqual([]);

    const viewers = await listAccessRequests(await fx.principalOf(viewerId));
    expect(viewers.toDecide).toEqual([]);
    expect(viewers.mine.map((r) => r.id)).toEqual([request.id]);
  });

  test("an admin who cannot open a restricted file does not answer for it", async () => {
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
      principals: [{ type: "user", id: viewerId }],
      level: "view",
    });
    const request = await requestAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
      level: "edit",
    });
    const adminId = await fx.addPerson({ role: "admin" });

    const admins = await listAccessRequests(await fx.principalOf(adminId));
    expect(admins.toDecide).toEqual([]);
    const owners = await listAccessRequests(owner);
    expect(owners.toDecide.map((r) => r.id)).toEqual([request.id]);
  });

  test("the share dialog shows the pending requests to whoever may answer them only", async () => {
    const { doc, request } = await askForEdit();

    const forOwner = await describeResourceAccess({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
    });
    expect(forOwner.requests.map((r) => r.id)).toEqual([request.id]);

    const forViewer = await describeResourceAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
    });
    expect(forViewer.requests).toEqual([]);
  });
});

describe("answering", () => {
  test("approving shares at the level asked for, closes the request and tells the requester", async () => {
    const { doc, request } = await askForEdit();

    const answered = await decideAccessRequest({
      principal: await fx.principalOf(ownerId),
      requestId: request.id,
      decision: "approve",
    });

    expect(answered).toMatchObject({
      status: "approved",
      decidedBy: { userId: ownerId },
      currentLevel: "edit",
    });
    expect(await levelOf(viewerId, doc)).toBe("edit");
    expect(await requestsOn(doc)).toMatchObject([
      { status: "approved", decidedBy: ownerId },
    ]);
    expect(await journal("grant.created")).toHaveLength(1);
    expect(await journal("request.decided")).toHaveLength(1);
    // Told once, whether the share or the decision closed the request.
    expect(sent.map((email) => email.to)).toEqual([await emailOf(viewerId)]);
  });

  test("approving at a lower level than asked still answers the request", async () => {
    const doc = await insertDocument();
    const request = await requestAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
      level: "full",
    });

    const answered = await decideAccessRequest({
      principal: await fx.principalOf(ownerId),
      requestId: request.id,
      decision: "approve",
      level: "edit",
    });

    expect(answered.status).toBe("approved");
    expect(await levelOf(viewerId, doc)).toBe("edit");
    const [entry] = await journal("request.decided");
    expect(entry?.metadata).toMatchObject({
      decision: "approved",
      requestedLevel: "full",
      level: "edit",
    });
  });

  test("denying closes the request and gives nothing", async () => {
    const { doc, request } = await askForEdit();

    const answered = await decideAccessRequest({
      principal: await fx.principalOf(ownerId),
      requestId: request.id,
      decision: "deny",
    });

    expect(answered).toMatchObject({ status: "denied", currentLevel: "view" });
    expect(await levelOf(viewerId, doc)).toBe("view");
    expect(await journal("grant.created")).toEqual([]);
    expect(sent.map((email) => email.to)).toEqual([await emailOf(viewerId)]);
  });

  test("a request is answered once", async () => {
    const { request } = await askForEdit();
    const owner = await fx.principalOf(ownerId);
    await decideAccessRequest({
      principal: owner,
      requestId: request.id,
      decision: "deny",
    });

    expect(
      await refusal(
        decideAccessRequest({
          principal: owner,
          requestId: request.id,
          decision: "approve",
        }),
      ),
    ).toEqual({ status: 409, code: "ACCESS_REQUEST_CLOSED" });
  });

  test("only someone who could share answers", async () => {
    const { request } = await askForEdit();
    const otherViewer = await fx.addPerson();
    await setTeamMemberRole({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      userId: otherViewer,
      role: "viewer",
    });

    expect(
      await refusal(
        decideAccessRequest({
          principal: await fx.principalOf(otherViewer),
          requestId: request.id,
          decision: "approve",
        }),
      ),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    expect(await requestsOn(request.resource.id)).toMatchObject([
      { status: "pending" },
    ]);
  });

  test("a request from someone who has left is withdrawn, not answered", async () => {
    const { doc, request } = await askForEdit();
    await db
      .delete(member)
      .where(
        and(
          eq(member.userId, viewerId),
          eq(member.organizationId, fx.organizationId),
        ),
      );
    await bumpAccessVersion(fx.organizationId);

    expect(
      await refusal(
        decideAccessRequest({
          principal: await fx.principalOf(ownerId),
          requestId: request.id,
          decision: "approve",
        }),
      ),
    ).toEqual({ status: 409, code: "ACCESS_REQUEST_CLOSED" });
    expect(await requestsOn(doc)).toMatchObject([{ status: "canceled" }]);
    expect(sent).toEqual([]);
  });

  test("a request in another organization reads as missing", async () => {
    const { request } = await askForEdit();
    const elsewhere = await createWorkspaceFixture();
    try {
      const [strangerId] = elsewhere.userIds;
      expect(
        await refusal(
          decideAccessRequest({
            principal: await elsewhere.principalOf(strangerId),
            requestId: request.id,
            decision: "approve",
          }),
        ),
      ).toMatchObject({ status: 404 });
    } finally {
      await elsewhere.cleanup();
    }
  });
});

describe("a share answers what it gives", () => {
  test("sharing at the level asked for approves the request", async () => {
    const { doc, request } = await askForEdit();

    await shareResource({
      principal: await fx.principalOf(ownerId),
      type: "document",
      id: doc,
      principals: [{ type: "user", id: viewerId }],
      level: "edit",
    });

    expect(await requestsOn(doc)).toMatchObject([
      { id: request.id, status: "approved", decidedBy: ownerId },
    ]);
    expect(sent.map((email) => email.to)).toEqual([await emailOf(viewerId)]);
  });

  test("a share below the level asked for leaves the request waiting", async () => {
    const doc = await insertDocument();
    const owner = await fx.principalOf(ownerId);
    await requestAccess({
      principal: await fx.principalOf(viewerId),
      type: "document",
      id: doc,
      level: "full",
    });
    await shareResource({
      principal: owner,
      type: "document",
      id: doc,
      principals: [{ type: "user", id: viewerId }],
      level: "edit",
    });
    expect(await requestsOn(doc)).toMatchObject([{ status: "pending" }]);

    await changeGrantLevel({
      principal: owner,
      type: "document",
      id: doc,
      holder: { type: "user", id: viewerId },
      level: "full",
    });
    expect(await requestsOn(doc)).toMatchObject([{ status: "approved" }]);
  });
});

describe("withdrawing", () => {
  test("the requester withdraws their own request, which can then not be answered", async () => {
    const { doc, request } = await askForEdit();
    await cancelAccessRequest({
      principal: await fx.principalOf(viewerId),
      requestId: request.id,
    });

    expect(await requestsOn(doc)).toMatchObject([{ status: "canceled" }]);
    expect(
      await refusal(
        decideAccessRequest({
          principal: await fx.principalOf(ownerId),
          requestId: request.id,
          decision: "approve",
        }),
      ),
    ).toEqual({ status: 409, code: "ACCESS_REQUEST_CLOSED" });
  });

  test("someone else's request reads as missing", async () => {
    const { doc, request } = await askForEdit();

    expect(
      await refusal(
        cancelAccessRequest({
          principal: await fx.principalOf(ownerId),
          requestId: request.id,
        }),
      ),
    ).toMatchObject({ status: 404 });
    expect(await requestsOn(doc)).toMatchObject([{ status: "pending" }]);
  });
});
