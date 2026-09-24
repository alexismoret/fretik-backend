/**
 * The `memory` tool, by where the turn works and who writes in it.
 *
 * A turn uses the namespaces its place gives it (`memoryNamespacesFor`): the
 * team's are its people's, a project's exist in the project's chats. A
 * project's notes follow the project's levels, as its instructions do in the
 * app: reading takes `view`, writing `edit`, and an archived project changes
 * nothing. Every answer here comes from the database and the access engine —
 * nothing about the person or the project is faked.
 */
import { loadPrincipal } from "@fretik/shared/authz/load-principal";
import db from "@fretik/shared/db";
import { aiMemories, member, user } from "@fretik/shared/db/schema";
import { shareResource } from "@fretik/shared/services/access/sharing/share";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { setProjectArchived } from "@fretik/shared/services/projects/archive";
import { createProject } from "@fretik/shared/services/projects/create";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import { wrapRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";
import { createMemoryTool } from "../../../src/tools/memory";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../lib/db-fixtures";

let fx: MemoryTestFixture;
/** Owner of the project (`full`). */
let ownerId: string;
/** A member of the team who takes part in the project (`use`). */
let takesPartId: string;
/** Someone of the organization outside the team, who edits the project. */
let outsiderId: string;
let projectId: string;
let conversationId: string;

const principal = async (userId: string) => {
  const loaded = await loadPrincipal({
    organizationId: fx.organizationId,
    userId,
  });
  if (!loaded) throw new Error("fixture: no principal");
  return loaded;
};

beforeAll(async () => {
  fx = await createMemoryTestFixture();
  [ownerId, takesPartId] = fx.userIds;
  const [outsider] = await db
    .insert(user)
    .values({
      name: "Outsider",
      email: `outsider-${randomUUID().slice(0, 8)}@example.test`,
      emailVerified: true,
    })
    .returning({ id: user.id });
  if (!outsider) throw new Error("fixture: no outsider");
  outsiderId = outsider.id;
  await db.insert(member).values({
    userId: outsiderId,
    organizationId: fx.organizationId,
    role: "member",
    createdAt: new Date(),
  });

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
  await shareResource({
    principal: await principal(ownerId),
    type: "project",
    id: projectId,
    principals: [{ type: "user", id: outsiderId }],
    level: "edit",
  });
  conversationId = await fx.createConversation();
  // The note every case reads: the cases run in any order.
  await createMemory({
    rawPath: "/memories/project/decisions.md",
    content: "Status goes out on Fridays.",
    scopeKey: {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: ownerId,
      projectId,
    },
    actor: { actor: "human", userId: ownerId },
  });
});

afterAll(async () => {
  await fx.cleanup();
});

type MemoryCall = Parameters<
  NonNullable<ReturnType<typeof createMemoryTool>["execute"]>
>[0];

/** One call of the tool, as the turn of `userId` in the given place. */
const memory = async (
  place: { userId: string; projectId?: string; outsideTeam?: boolean },
  input: MemoryCall,
): Promise<Record<string, unknown>> => {
  const execute = createMemoryTool().execute;
  if (!execute) throw new Error("memory tool has no execute fn");
  const context = wrapRuntimeContext({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: place.userId,
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
    ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
    ...(place.outsideTeam === undefined
      ? {}
      : { outsideTeam: place.outsideTeam }),
  });
  const out: unknown = await Promise.resolve(
    execute(input, { toolCallId: "call-test", messages: [], context }),
  );
  if (typeof out !== "object" || out === null) throw new Error("no output");
  return out as Record<string, unknown>;
};

/** Whether the project holds a note at this path. */
const hasNote = async (path: string): Promise<boolean> => {
  const rows = await db
    .select({ path: aiMemories.path })
    .from(aiMemories)
    .where(eq(aiMemories.projectId, projectId));
  return rows.some((row) => row.path === path);
};

describe("the memory tool", () => {
  test("offers a project's notes only in the project's chats", async () => {
    const out = await memory(
      { userId: ownerId },
      { command: "view", path: "/memories/project/" },
    );
    expect(out.code).toBe(TOOL_ERROR_CODES.MEMORY_NAMESPACE_UNAVAILABLE);
  });

  test("writes a project's notes for whoever may edit the project", async () => {
    const out = await memory(
      { userId: ownerId, projectId },
      {
        command: "create",
        path: "/memories/project/contacts.md",
        file_text: "Reports go to the sponsor.",
      },
    );
    expect(out.ok).toBe(true);
    expect(await hasNote("contacts.md")).toBe(true);
  });

  test("lets someone who takes part read them, not write them", async () => {
    const read = await memory(
      { userId: takesPartId, projectId },
      { command: "view", path: "/memories/project/decisions.md" },
    );
    expect(read.ok).toBe(true);

    const write = await memory(
      { userId: takesPartId, projectId },
      {
        command: "create",
        path: "/memories/project/other.md",
        file_text: "Something.",
      },
    );
    expect(write.ok).toBeUndefined();
    expect(write.code).toBeDefined();
    expect(await hasNote("other.md")).toBe(false);
  });

  test("keeps the team's notes from someone outside the team", async () => {
    const team = await memory(
      { userId: outsiderId, projectId, outsideTeam: true },
      { command: "view", path: "/memories/team/" },
    );
    expect(team.code).toBe(TOOL_ERROR_CODES.MEMORY_NAMESPACE_UNAVAILABLE);

    // The project's are theirs to use, at their level on it.
    const project = await memory(
      { userId: outsiderId, projectId, outsideTeam: true },
      {
        command: "overwrite",
        path: "/memories/project/decisions.md",
        file_text: "Status goes out on Thursdays.",
      },
    );
    expect(project.ok).toBe(true);
  });

  test("changes nothing in an archived project", async () => {
    await setProjectArchived({
      principal: await principal(ownerId),
      projectId,
      archived: true,
    });
    try {
      const out = await memory(
        { userId: ownerId, projectId },
        { command: "delete", path: "/memories/project/decisions.md" },
      );
      expect(out.code).toBe("PROJECT_ARCHIVED");
      expect(await hasNote("decisions.md")).toBe(true);
    } finally {
      await setProjectArchived({
        principal: await principal(ownerId),
        projectId,
        archived: false,
      });
    }
  });
});
