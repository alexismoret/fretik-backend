import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { requireDriveAction } from "../../../src/authz/drive";
import { parseApiError } from "../../../src/schemas/errors";
import { requesterMayContribute } from "../../../src/services/approvals/requester-access";
import { assertCanWriteRecord } from "../../../src/services/collection-sharing/write-access";
import { dispatchCollections } from "../../../src/services/sandbox/collections";
import { setTeamMemberRole } from "../../../src/services/team/set-role";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A team viewer reads. Every door that changes the team's content refuses
 * them — not only the API's routes, which declare it, but the doors that are
 * not routes: the collection write checks the assistant's tools share with
 * the API, the Drive rules the tools apply, the Python bridge's writes, and
 * an approval granted after the person was made a viewer.
 *
 * Each case is paired with the same call for a MEMBER, so a refusal cannot be
 * the refusal of a door that refuses everyone.
 */

let fx: WorkspaceFixture;
let viewerId: string;
let memberId: string;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  const [ownerId, second] = fx.userIds;
  viewerId = second;
  memberId = await fx.addPerson();
  await setTeamMemberRole({
    principal: await fx.principalOf(ownerId),
    teamId: fx.teamId,
    userId: viewerId,
    role: "viewer",
  });
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

describe("a team viewer", () => {
  test("writes no record, even of their own team's collection", async () => {
    const collection = await fx.createCollection();
    const record = await fx.createRecord({ collectionId: collection.id });
    const scope = {
      recordId: record.id,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
    };

    expect(
      await refusal(assertCanWriteRecord({ ...scope, userId: viewerId })),
    ).toEqual({ status: 403, code: "ACCESS_DENIED" });
    await assertCanWriteRecord({ ...scope, userId: memberId });
    // No person behind the write: the team acting for itself.
    await assertCanWriteRecord({ ...scope, userId: undefined });
  });

  test("adds nothing to the Drive", async () => {
    const viewer = await fx.principalOf(viewerId);
    const member = await fx.principalOf(memberId);
    const newFolder = {
      kind: "createFolder",
      teamId: fx.teamId,
      parentFolderId: null,
    } as const;
    const newDocument = {
      kind: "addDocument",
      teamId: fx.teamId,
      folderId: null,
    } as const;

    expect(await refusal(requireDriveAction(viewer, newFolder))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
    expect(await refusal(requireDriveAction(viewer, newDocument))).toEqual({
      status: 403,
      code: "ACCESS_DENIED",
    });
    await requireDriveAction(member, newFolder);
    await requireDriveAction(member, newDocument);
  });

  test("changes no collection through the Python bridge, and still reads", async () => {
    const collection = await fx.createCollection();
    const context = (userId: string) => ({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId,
      conversationId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
    });
    const create = { collectionKey: collection.key, rows: [{ data: {} }] };

    const refused = await dispatchCollections(
      context(viewerId),
      "records.bulk_create",
      create,
    );
    const read = await dispatchCollections(context(viewerId), "records.query", {
      collectionKey: collection.key,
    });

    const messageOf = (response: typeof read): string =>
      response.status === "error" ? response.message : "";
    expect(refused.status).toBe("error");
    expect(messageOf(refused)).toStartWith("ACCESS_DENIED");
    expect(read.status).toBe("ok");
  });

  test("gets nothing written by an approval granted after they became one", async () => {
    const approval = (userId: string) => ({
      userId,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
    });

    expect(await requesterMayContribute(approval(viewerId))).toBe(false);
    expect(await requesterMayContribute(approval(memberId))).toBe(true);
  });
});
