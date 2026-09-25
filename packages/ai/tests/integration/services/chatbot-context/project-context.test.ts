/**
 * What a chat reads before it starts, by where it is and who writes in it.
 *
 * A project chat reads its project: the instructions its people wrote, and
 * its files as the reader sees them — a file kept to one person is never
 * announced to the others. The team's persistent context follows the reader:
 * all of it in the team's own chats, its instructions only in a project's,
 * none of it for someone who is not one of the team's people.
 */
import { loadPrincipal } from "@fretik/shared/authz/load-principal";
import db from "@fretik/shared/db";
import {
  aiContextFiles,
  aiContextProfiles,
  documents,
} from "@fretik/shared/db/schema";
import { shareResource } from "@fretik/shared/services/access/sharing/share";
import { createDocumentRecord } from "@fretik/shared/services/documents/upload";
import { createProject } from "@fretik/shared/services/projects/create";
import { updateProject } from "@fretik/shared/services/projects/update";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { loadAccessibleContext } from "../../../../src/services/chatbot-context/load-context";
import { buildProjectContextSection } from "../../../../src/services/chatbot-context/project-context";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

let fx: MemoryTestFixture;
let ownerId: string;
let takesPartId: string;
let projectId: string;
const names = {
  open: `brief-${randomUUID().slice(0, 6)}.pdf`,
  keptToOwner: `draft-${randomUUID().slice(0, 6)}.pdf`,
  team: `team-${randomUUID().slice(0, 6)}.pdf`,
};

const principal = async (userId: string) => {
  const loaded = await loadPrincipal({
    organizationId: fx.organizationId,
    userId,
  });
  if (!loaded) throw new Error("fixture: no principal");
  return loaded;
};

const file = async (filename: string, inProject: string | null) =>
  createDocumentRecord({
    metadata: {
      id: randomUUID(),
      folderId: null,
      originalFilename: filename,
      fileSize: 2048,
      mimeType: "application/pdf",
      fileHash: randomUUID(),
    },
    teamId: fx.teamId,
    userId: ownerId,
    projectId: inProject,
    status: "ready",
  });

beforeAll(async () => {
  fx = await createMemoryTestFixture();
  [ownerId, takesPartId] = fx.userIds;
  projectId = (
    await createProject({
      principal: await principal(ownerId),
      teamId: fx.teamId,
      project: { name: "Acme case", description: "", restricted: true },
    })
  ).id;
  await shareResource({
    principal: await principal(ownerId),
    type: "project",
    id: projectId,
    principals: [{ type: "user", id: takesPartId }],
    level: "use",
  });
  await updateProject({
    principal: await principal(ownerId),
    projectId,
    patch: { instructions: "Answer in short bullet points." },
  });
  await file(names.open, projectId);
  const kept = await file(names.keptToOwner, projectId);
  await db
    .update(documents)
    .set({ accessRestricted: true, ownerUserId: ownerId })
    .where(eq(documents.id, kept.id));
  await file(names.team, null);
});

afterAll(async () => {
  await fx.cleanup();
});

describe("a project chat's context", () => {
  test("carries the project's instructions and the files its reader sees", async () => {
    const section = await buildProjectContextSection({
      projectId,
      teamId: fx.teamId,
      principal: await principal(takesPartId),
    });
    expect(section).toContain("## Project: Acme case");
    expect(section).toContain("### Project instructions");
    expect(section).toContain("Answer in short bullet points.");
    expect(section).toContain(names.open);
    expect(section).not.toContain(names.keptToOwner);
    expect(section).not.toContain(names.team);
  });

  test("lists a file kept to one person for that person only", async () => {
    const section = await buildProjectContextSection({
      projectId,
      teamId: fx.teamId,
      principal: await principal(ownerId),
    });
    expect(section).toContain(names.keptToOwner);
    expect(section).not.toContain(names.team);
  });
});

describe("the team's persistent context", () => {
  let userFileId: string;
  let teamFileId: string;

  beforeAll(async () => {
    const [teamProfile, userProfile] = await db
      .insert(aiContextProfiles)
      .values([
        {
          scope: "team",
          organizationId: fx.organizationId,
          teamId: fx.teamId,
          instructions: "Quotes need two carriers.",
        },
        {
          scope: "user",
          organizationId: fx.organizationId,
          userId: takesPartId,
          instructions: "I prefer tables.",
        },
      ])
      .returning({ id: aiContextProfiles.id });
    if (!teamProfile || !userProfile) throw new Error("fixture: no profiles");
    const contextFile = (profileId: string, filename: string) => ({
      profileId,
      organizationId: fx.organizationId,
      filename,
      mimeType: "text/markdown",
      size: 10,
      fileHash: randomUUID(),
      s3Key: `context/${randomUUID()}`,
      status: "ready" as const,
    });
    const [teamFile, userFile] = await db
      .insert(aiContextFiles)
      .values([
        contextFile(teamProfile.id, "team-rules.md"),
        contextFile(userProfile.id, "my-notes.md"),
      ])
      .returning({ id: aiContextFiles.id });
    if (!teamFile || !userFile) throw new Error("fixture: no files");
    teamFileId = teamFile.id;
    userFileId = userFile.id;
  });

  const load = (teamReach: "all" | "instructions" | "none") =>
    loadAccessibleContext({
      userId: takesPartId,
      teamId: fx.teamId,
      organizationId: fx.organizationId,
      teamReach,
    });

  test("is whole in the team's own chats", async () => {
    const loaded = await load("all");
    expect(loaded.teamProfile?.instructions).toBe("Quotes need two carriers.");
    expect(loaded.userProfile?.instructions).toBe("I prefer tables.");
    expect(loaded.files.map((f) => f.id).sort()).toEqual(
      [teamFileId, userFileId].sort(),
    );
  });

  test("is its instructions only in a project's chat", async () => {
    const loaded = await load("instructions");
    expect(loaded.teamProfile?.instructions).toBe("Quotes need two carriers.");
    expect(loaded.files.map((f) => f.id)).toEqual([userFileId]);
  });

  test("is none of it for someone outside the team", async () => {
    const loaded = await load("none");
    expect(loaded.teamProfile).toBeNull();
    expect(loaded.userProfile?.instructions).toBe("I prefer tables.");
    expect(loaded.files.map((f) => f.id)).toEqual([userFileId]);
  });
});
