import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { aiContextFiles, aiContextProfiles } from "../../../src/db/schema";
import type { ScopeKey } from "../../../src/services/ai-context/retrieve";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Who may read, toggle and delete a chatbot context file.
 *
 * A context file belongs to a PROFILE, and a profile is scoped to one team or
 * to one person. `ai_context_files` also carries a denormalised
 * `organization_id`, added — per its own comment — so handlers could "filter by
 * organisation without an extra JOIN". Three services then used that column as
 * the authorisation boundary, which is a different thing entirely: an
 * organisation is not a team, and it is certainly not a person.
 *
 * The consequence, reachable through `/chatbot-context/{scope}/{fileId}/…`:
 * with a file id in hand, any member of the organisation could read another
 * team's context file, read a COLLEAGUE'S PERSONAL one (the `content` column is
 * the extracted text of whatever they uploaded), flip it off so the assistant
 * silently stopped using it, or delete it outright. Exploiting it needs the id,
 * which is not guessable — but ids travel: logs, screenshots, support threads,
 * the agent's own tool output.
 *
 * These tests are the boundary, stated once per verb. They were written red.
 *
 * S3, the sidecar store and the AI service are doubled: they are process
 * boundaries, and a delete must be provable without a bucket.
 */

const deletedObjects: string[] = [];

await mockModule("../../src/lib/s3", {
  deleteObject: (key: string) => {
    deletedObjects.push(key);
    return Promise.resolve();
  },
});
await mockModule("../../src/lib/ai-context-storage", {
  deleteContextSidecar: () => Promise.resolve(),
});
await mockModule("../../src/lib/ai-service", {
  callAiService: () => Promise.resolve({ success: true }),
});

const { deleteContextFile } =
  await import("../../../src/services/ai-context/delete");
const { getContextFileContent } =
  await import("../../../src/services/ai-context/retrieve");
const { setContextFileEnabled } =
  await import("../../../src/services/ai-context/update");

let owner: WorkspaceFixture;
let intruder: WorkspaceFixture;

/**
 * The workspace's profile for a scope, created once.
 *
 * `ai_context_profiles` is uniquely keyed on (team, org) and (user, org) — one
 * profile per scope, by design — so a test that wants a second file adds it to
 * the profile that is already there.
 */
const profiles = new Map<string, string>();
let seeded = 0;

const profileFor = async (
  workspace: WorkspaceFixture,
  scope: "team" | "user",
): Promise<string> => {
  const memo = `${workspace.organizationId}:${scope}`;
  const known = profiles.get(memo);
  if (known !== undefined) return known;
  const [row] = await db
    .insert(aiContextProfiles)
    .values({
      scope,
      organizationId: workspace.organizationId,
      teamId: scope === "team" ? workspace.teamId : null,
      userId: scope === "user" ? workspace.userIds[0] : null,
      instructions: "",
    })
    .returning({ id: aiContextProfiles.id });
  if (!row) throw new Error("failed to insert context profile");
  profiles.set(memo, row.id);
  return row.id;
};

/** A file in the workspace's profile for that scope. */
const seedFile = async (
  workspace: WorkspaceFixture,
  scope: "team" | "user",
): Promise<{ fileId: string; key: ScopeKey }> => {
  const profileId = await profileFor(workspace, scope);
  // `ai_context_files` is unique on (profile, filename) — each seeded file
  // needs its own name, since they all share the one profile per scope.
  seeded += 1;
  const filename = `handbook-${seeded.toString()}.md`;

  const [file] = await db
    .insert(aiContextFiles)
    .values({
      profileId,
      organizationId: workspace.organizationId,
      filename,
      mimeType: "text/markdown",
      size: 12,
      fileHash: "sha256-test",
      s3Key: `context/${profileId}/${filename}`,
      status: "ready",
      content: "the private text nobody else should read",
    })
    .returning({ id: aiContextFiles.id });
  if (!file) throw new Error("failed to insert context file");

  return {
    fileId: file.id,
    key: {
      scope,
      userId: workspace.userIds[0],
      teamId: workspace.teamId,
      organizationId: workspace.organizationId,
    },
  };
};

/** The caller's own scope key inside a workspace, for a given member. */
const keyFor = (
  workspace: WorkspaceFixture,
  scope: "team" | "user",
  member: 0 | 1 = 0,
): ScopeKey => ({
  scope,
  userId: workspace.userIds[member],
  teamId: workspace.teamId,
  organizationId: workspace.organizationId,
});

const stillThere = async (fileId: string): Promise<boolean> => {
  const row = await db.query.aiContextFiles.findFirst({
    where: { id: fileId },
    columns: { id: true },
  });
  return row !== undefined;
};

beforeAll(async () => {
  owner = await createWorkspaceFixture();
  intruder = await createWorkspaceFixture();
});

afterAll(async () => {
  await owner.cleanup();
  await intruder.cleanup();
});

describe("the owner keeps working", () => {
  test("reads, toggles and deletes its own team file", async () => {
    const { fileId, key } = await seedFile(owner, "team");

    const read = await getContextFileContent({ fileId, scope: key });
    expect(read.content).toContain("private text");

    await setContextFileEnabled({ fileId, scope: key, enabled: false });
    const toggled = await db.query.aiContextFiles.findFirst({
      where: { id: fileId },
      columns: { enabled: true },
    });
    expect(toggled?.enabled).toBe(false);

    await deleteContextFile({ fileId, scope: key });
    expect(await stillThere(fileId)).toBe(false);
    expect(deletedObjects.at(-1)).toContain("handbook-");
  });

  test("a second member of the same team shares the team profile", async () => {
    // Team scope is shared by design — the distinction being drawn is between
    // teams and between people, not between colleagues on one team.
    const { fileId } = await seedFile(owner, "team");
    const colleague = keyFor(owner, "team", 1);
    expect(
      (await getContextFileContent({ fileId, scope: colleague })).content,
    ).toContain("private text");
  });
});

describe("another team in the same organisation", () => {
  test("cannot read the file", async () => {
    const { fileId } = await seedFile(owner, "team");
    // Same organisation id, different team — the exact shape the old
    // `where: { id, organizationId }` could not tell apart.
    const trespasser: ScopeKey = {
      scope: "team",
      userId: intruder.userIds[0],
      teamId: intruder.teamId,
      organizationId: owner.organizationId,
    };
    const err = await rejection(
      getContextFileContent({ fileId, scope: trespasser }),
    );
    expect(err.message).toContain("not found");
  });

  test("cannot switch the file off", async () => {
    const { fileId } = await seedFile(owner, "team");
    const trespasser: ScopeKey = {
      scope: "team",
      userId: intruder.userIds[0],
      teamId: intruder.teamId,
      organizationId: owner.organizationId,
    };
    await rejection(
      setContextFileEnabled({ fileId, scope: trespasser, enabled: false }),
    );
    const row = await db.query.aiContextFiles.findFirst({
      where: { id: fileId },
      columns: { enabled: true },
    });
    expect(row?.enabled).toBe(true);
  });

  test("cannot delete the file", async () => {
    const { fileId } = await seedFile(owner, "team");
    const trespasser: ScopeKey = {
      scope: "team",
      userId: intruder.userIds[0],
      teamId: intruder.teamId,
      organizationId: owner.organizationId,
    };
    await rejection(deleteContextFile({ fileId, scope: trespasser }));
    expect(await stillThere(fileId)).toBe(true);
  });
});

describe("a colleague's personal file", () => {
  test("is not readable by another member of the same team", async () => {
    // The worst of the three: `content` is the extracted text of a document
    // somebody uploaded to their OWN assistant, and both members are in the
    // same organisation, so the organisation check passed unconditionally.
    const { fileId } = await seedFile(owner, "user");
    const err = await rejection(
      getContextFileContent({ fileId, scope: keyFor(owner, "user", 1) }),
    );
    expect(err.message).toContain("not found");
  });

  test("is not deletable by another member of the same team", async () => {
    const { fileId } = await seedFile(owner, "user");
    await rejection(
      deleteContextFile({ fileId, scope: keyFor(owner, "user", 1) }),
    );
    expect(await stillThere(fileId)).toBe(true);
  });

  test("its owner still reaches it", async () => {
    const { fileId, key } = await seedFile(owner, "user");
    expect(
      (await getContextFileContent({ fileId, scope: key })).content,
    ).toContain("private text");
  });
});

describe("the scope named in the request must be the file's own", () => {
  test("a team file is not reachable through the personal scope", async () => {
    // The route carries the scope in its path (`/chatbot-context/user/…`), and
    // the profile lookup follows it. Asking for a team file down the personal
    // path resolves the caller's personal profile, which does not own it.
    const { fileId } = await seedFile(owner, "team");
    await rejection(
      getContextFileContent({ fileId, scope: keyFor(owner, "user") }),
    );
  });
});
