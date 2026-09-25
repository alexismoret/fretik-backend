import { inArray } from "drizzle-orm";
import type { UserPrincipal } from "../../src/authz/principal";
import db from "../../src/db";
import {
  accessGrants,
  documents,
  folders,
  member,
  teamMember,
  teamMemberRoles,
  user,
} from "../../src/db/schema";
import type { AccessLevel } from "../../src/schemas/access";
import type { WorkspaceFixture } from "./db-fixtures";

/**
 * A Drive built to disagree: restricted folders with shared folders inside,
 * open documents in closed folders, grants to a person, the team, the
 * organization, one expired — and four people who each see a different
 * Drive. The engine (`rules.ts`) is the reference; every other reading of the
 * Drive is held to it on this tree: the lists (`drive-sql.ts`), the SQL tool's
 * policies, the records that mirror files.
 *
 *   open/                          owner's, open to the team
 *     doc
 *     restricted-doc               the member's, restricted
 *     closed/                      restricted
 *       doc
 *       sub/doc
 *     shared-with-member/          restricted, shared with the member
 *       doc
 *   closed/                        restricted
 *     team/                        shared with the whole team (edit)
 *       doc
 *     doc-for-outsider             shared with someone of another team
 *     expired/                     shared with the member, expired
 *   root                           open
 *   root-restricted
 *   root-restricted-org            restricted, shared with the organization
 *   root-owned-by-member           restricted, the member's
 */
export interface DriveTree {
  readonly owner: string;
  readonly member: string;
  /** A team viewer: reads the team's content, writes none of it. */
  readonly viewer: string;
  /** Someone of another team of the organization. */
  readonly outsider: string;
  readonly otherTeamId: string;
  /** Folder ids by their path in the tree above. */
  readonly folders: ReadonlyMap<string, string>;
  /** Document ids by their path in the tree above. */
  readonly documents: ReadonlyMap<string, string>;
  /** The four people, by name. */
  readonly people: () => Promise<[string, UserPrincipal][]>;
  /** The tree path of an id. */
  readonly nameOf: (ids: ReadonlyMap<string, string>, id: string) => string;
  /** Removes the people this tree added (the fixture drops the rest). */
  readonly cleanup: () => Promise<void>;
}

export const buildDriveTree = async (
  fx: WorkspaceFixture,
): Promise<DriveTree> => {
  const [owner, memberId] = fx.userIds;
  const otherTeamId = (await fx.createTeam()).id;
  const folderIds = new Map<string, string>();
  const documentIds = new Map<string, string>();

  const addPerson = async (
    name: string,
    teamId: string,
    role: "member" | "viewer",
  ): Promise<string> => {
    const [row] = await db
      .insert(user)
      .values({
        name,
        email: `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`,
        emailVerified: true,
      })
      .returning({ id: user.id });
    if (!row) throw new Error("fixture: no user");
    await db.insert(member).values({
      userId: row.id,
      organizationId: fx.organizationId,
      role: "member",
      createdAt: new Date(),
    });
    const [seat] = await db
      .insert(teamMember)
      .values({ userId: row.id, teamId, createdAt: new Date() })
      .returning({ id: teamMember.id });
    if (!seat) throw new Error("fixture: no team seat");
    if (role === "viewer") {
      await db
        .insert(teamMemberRoles)
        .values({ teamMemberId: seat.id, teamId, userId: row.id, role });
    }
    return row.id;
  };

  const addFolder = async (
    key: string,
    shape: { parent?: string; restricted?: boolean } = {},
  ): Promise<string> => {
    const [row] = await db
      .insert(folders)
      .values({
        teamId: fx.teamId,
        name: key,
        parentFolderId:
          shape.parent === undefined ? null : folderIds.get(shape.parent),
        fullPath: `/${key}`,
        ownerUserId: owner,
        createdById: owner,
        accessRestricted: shape.restricted ?? false,
      })
      .returning({ id: folders.id });
    if (!row) throw new Error("fixture: no folder");
    folderIds.set(key, row.id);
    return row.id;
  };

  const addDocument = async (
    key: string,
    shape: { folder?: string; restricted?: boolean; ownerUserId?: string } = {},
  ): Promise<string> => {
    const [row] = await db
      .insert(documents)
      .values({
        teamId: fx.teamId,
        folderId:
          shape.folder === undefined ? null : folderIds.get(shape.folder),
        status: "ready",
        originalFilename: `${key}.pdf`,
        fileSize: 1,
        mimeType: "application/pdf",
        fileHash: crypto.randomUUID(),
        ownerUserId: shape.ownerUserId ?? owner,
        uploadedById: shape.ownerUserId ?? owner,
        accessRestricted: shape.restricted ?? false,
      })
      .returning({ id: documents.id });
    if (!row) throw new Error("fixture: no document");
    documentIds.set(key, row.id);
    return row.id;
  };

  const grant = async (input: {
    resourceType: "folder" | "document";
    resourceId: string;
    principalType: "user" | "team" | "organization";
    principalId: string;
    level: AccessLevel;
    expiresAt?: Date;
  }): Promise<void> => {
    await db
      .insert(accessGrants)
      .values({ organizationId: fx.organizationId, ...input });
  };

  const viewer = await addPerson("viewer", fx.teamId, "viewer");
  const outsider = await addPerson("outsider", otherTeamId, "member");

  // An open folder, with a closed corner and a corner shared with the member.
  await addFolder("open");
  await addDocument("open/doc", { folder: "open" });
  await addDocument("open/restricted-doc", {
    folder: "open",
    restricted: true,
    ownerUserId: memberId,
  });
  await addFolder("open/closed", { parent: "open", restricted: true });
  await addDocument("open/closed/doc", { folder: "open/closed" });
  await addFolder("open/closed/sub", { parent: "open/closed" });
  await addDocument("open/closed/sub/doc", { folder: "open/closed/sub" });
  await grant({
    resourceType: "folder",
    resourceId: await addFolder("open/shared-with-member", {
      parent: "open",
      restricted: true,
    }),
    principalType: "user",
    principalId: memberId,
    level: "view",
  });
  await addDocument("open/shared-with-member/doc", {
    folder: "open/shared-with-member",
  });

  // A closed folder with a corner shared with the whole team, and a document
  // shared with someone from another team.
  await addFolder("closed", { restricted: true });
  await grant({
    resourceType: "folder",
    resourceId: await addFolder("closed/team", { parent: "closed" }),
    principalType: "team",
    principalId: fx.teamId,
    level: "edit",
  });
  await addDocument("closed/team/doc", { folder: "closed/team" });
  await grant({
    resourceType: "document",
    resourceId: await addDocument("closed/doc-for-outsider", {
      folder: "closed",
    }),
    principalType: "user",
    principalId: outsider,
    level: "view",
  });
  await grant({
    resourceType: "folder",
    resourceId: await addFolder("closed/expired", { parent: "closed" }),
    principalType: "user",
    principalId: memberId,
    level: "full",
    expiresAt: new Date(Date.now() - 60_000),
  });

  // The root.
  await addDocument("root");
  await addDocument("root-restricted", { restricted: true });
  await grant({
    resourceType: "document",
    resourceId: await addDocument("root-restricted-org", { restricted: true }),
    principalType: "organization",
    principalId: fx.organizationId,
    level: "view",
  });
  await addDocument("root-owned-by-member", {
    restricted: true,
    ownerUserId: memberId,
  });

  return {
    owner,
    member: memberId,
    viewer,
    outsider,
    otherTeamId,
    folders: folderIds,
    documents: documentIds,
    people: async () => [
      ["owner", await fx.principalOf(owner)],
      ["member", await fx.principalOf(memberId)],
      ["viewer", await fx.principalOf(viewer)],
      ["outsider", await fx.principalOf(outsider)],
    ],
    nameOf: (ids, id) => [...ids].find(([, value]) => value === id)?.[0] ?? id,
    cleanup: async () => {
      await db.delete(user).where(inArray(user.id, [viewer, outsider]));
    },
  };
};
