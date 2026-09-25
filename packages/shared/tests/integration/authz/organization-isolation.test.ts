import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import {
  type EngineResourceType,
  resolveAccessMany,
} from "../../../src/authz/access";
import db from "../../../src/db";
import {
  accessGrants,
  documents,
  folders,
  projects,
} from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Organization isolation: nothing of one organization reaches a principal of
 * another, whatever the grants say.
 *
 * The engine decides on the item's organization before anything else
 * (`authz/rules.ts`), the lists filter by a team or an organization the
 * person belongs to, and grants are only ever written to principals the
 * organization holds (`sharing/principals.ts`). Postgres does not hold the
 * application to any of it (row-level security by organization is a
 * follow-up, `docs/ACCESS-CONTROL.md`), so this suite plants the rows no code
 * path writes, grants naming someone of another organization, and checks
 * that nothing follows from them.
 */

// Inviting to a team sends an email; nothing here is about it.
await mockModule("../../src/lib/email", {
  sendEmail: () => Promise.resolve(),
});
const { inviteToTeam } =
  await import("../../../src/services/invitations/invite-to-team");
const { shareResource } =
  await import("../../../src/services/access/sharing/share");
const { listSharedWithMe } =
  await import("../../../src/services/access/sharing/list-shared-with-me");

let here: WorkspaceFixture;
let there: WorkspaceFixture;
/** Someone of the other organization, who is given everything below. */
let stranger: string;

beforeEach(async () => {
  [here, there] = await Promise.all([
    createWorkspaceFixture(),
    createWorkspaceFixture(),
  ]);
  stranger = there.userIds[0];
});

afterEach(async () => {
  await Promise.all([here.cleanup(), there.cleanup()]);
});

const status = async (promise: Promise<unknown>): Promise<number> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return error.status;
};

/** One item of each kind this organization holds, owned by its owner. */
const itemsHere = async (): Promise<
  { type: EngineResourceType; id: string }[]
> => {
  const [ownerId] = here.userIds;
  const tag = randomUUID().slice(0, 8);
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: here.organizationId,
      teamId: here.teamId,
      name: `project-${tag}`,
      ownerUserId: ownerId,
    })
    .returning({ id: projects.id });
  const [folder] = await db
    .insert(folders)
    .values({
      teamId: here.teamId,
      name: `folder-${tag}`,
      fullPath: `/folder-${tag}`,
      createdById: ownerId,
      ownerUserId: ownerId,
    })
    .returning({ id: folders.id });
  const [document] = await db
    .insert(documents)
    .values({
      teamId: here.teamId,
      status: "ready",
      originalFilename: `file-${tag}.pdf`,
      fileSize: 1024,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
      ownerUserId: ownerId,
      uploadedById: ownerId,
    })
    .returning({ id: documents.id });
  if (!project || !folder || !document) throw new Error("fixture: no items");
  return [
    { type: "project", id: project.id },
    { type: "folder", id: folder.id },
    { type: "document", id: document.id },
    { type: "page", id: (await here.createPage()).id },
    {
      type: "conversation",
      id: (await here.createConversation({ userId: ownerId })).id,
    },
    { type: "collection", id: (await here.createCollection()).id },
  ];
};

/** What the stranger can open of `items`, as `type:id`. */
const reachedByStranger = async (
  items: readonly { type: EngineResourceType; id: string }[],
): Promise<string[]> => {
  const principal = await there.principalOf(stranger);
  const reached = await Promise.all(
    items.map(async ({ type, id }) =>
      [...(await resolveAccessMany(principal, type, [id])).keys()].map(
        (key) => `${type}:${key}`,
      ),
    ),
  );
  return reached.flat();
};

describe("a grant that crosses organizations", () => {
  test("gives the person it names nothing", async () => {
    const items = await itemsHere();
    await db.insert(accessGrants).values(
      items.map(({ type, id }) => ({
        organizationId: here.organizationId,
        resourceType: type,
        resourceId: id,
        principalType: "user" as const,
        principalId: stranger,
        level: "full" as const,
      })),
    );

    expect(await reachedByStranger(items)).toEqual([]);
    expect(
      (await listSharedWithMe(await there.principalOf(stranger))).items,
    ).toEqual([]);
  });

  test("gives nothing to the organization it names, nor to its teams", async () => {
    const items = await itemsHere();
    await db.insert(accessGrants).values(
      items.flatMap(({ type, id }) => [
        {
          organizationId: here.organizationId,
          resourceType: type,
          resourceId: id,
          principalType: "organization" as const,
          principalId: there.organizationId,
          level: "full" as const,
        },
        {
          organizationId: there.organizationId,
          resourceType: type,
          resourceId: id,
          principalType: "team" as const,
          principalId: there.teamId,
          level: "full" as const,
        },
      ]),
    );

    expect(await reachedByStranger(items)).toEqual([]);
    expect(
      (await listSharedWithMe(await there.principalOf(stranger))).items,
    ).toEqual([]);
  });
});

describe("the doors that write", () => {
  test("never share with someone of another organization", async () => {
    const page = await here.createPage();
    expect(
      await status(
        shareResource({
          principal: await here.principalOf(here.userIds[0]),
          type: "page",
          id: page.id,
          principals: [{ type: "user", id: stranger }],
          level: "view",
        }),
      ),
    ).toBeGreaterThanOrEqual(400);
    expect(await reachedByStranger([{ type: "page", id: page.id }])).toEqual(
      [],
    );
  });

  test("never find a team of another organization", async () => {
    expect(
      await status(
        inviteToTeam({
          principal: await here.principalOf(here.userIds[0]),
          teamId: there.teamId,
          invitations: [
            {
              email: `it-${randomUUID().slice(0, 8)}@example.test`,
              role: "member",
            },
          ],
        }),
      ),
    ).toBe(404);
  });
});
