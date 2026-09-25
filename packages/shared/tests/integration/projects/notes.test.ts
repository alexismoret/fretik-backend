import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import {
  aiMemories,
  aiMemoryHistory,
  aiVectors,
  folders,
  toolApprovalRequests,
  workflowRuns,
  workflows,
} from "../../../src/db/schema";
import { parseApiError } from "../../../src/schemas/errors";
import { createMemory } from "../../../src/services/ai-memory/create";
import { deleteAllMemories } from "../../../src/services/ai-memory/delete-all";
import {
  getMemoryContent,
  requireProjectMemoryContent,
} from "../../../src/services/ai-memory/get-content";
import { getProjectMemoryHistory } from "../../../src/services/ai-memory/get-history";
import {
  listMemoriesForUi,
  listProjectMemoriesForUi,
} from "../../../src/services/ai-memory/list-for-ui";
import { buildMemoryIndexManifest } from "../../../src/services/ai-memory/list-index";
import { findMemoryByPath } from "../../../src/services/ai-memory/lookup";
import { memoryNamespacesFor } from "../../../src/services/ai-memory/namespaces";
import type { MemoryScopeKey } from "../../../src/services/ai-memory/types";
import { refreshSourceVectorAcl } from "../../../src/services/ai-vectors/acl";
import { toolCallHandler } from "../../../src/services/approvals/kinds/tool-call";
import { createProject } from "../../../src/services/projects/create";
import { deleteProject } from "../../../src/services/projects/delete";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A project's notes for the assistant (`/memories/project/`): keyed on the
 * project, found by its people's searches, never listed by its team's own
 * settings, and gone with the project. And what the assistant writes at a
 * root, once approved, lands at the root of the project it was asked in.
 */

let fx: WorkspaceFixture;
let ownerId: string;
let projectA: string;
let projectB: string;

const newProject = async (name: string): Promise<string> =>
  (
    await createProject({
      principal: await fx.principalOf(ownerId),
      teamId: fx.teamId,
      project: { name, description: "", restricted: true },
    })
  ).id;

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [ownerId] = fx.userIds;
  projectA = await newProject("Acme case");
  projectB = await newProject("Globex case");
});

afterEach(async () => {
  await fx.cleanup();
});

const keyIn = (projectId?: string): MemoryScopeKey => ({
  organizationId: fx.organizationId,
  teamId: fx.teamId,
  userId: ownerId,
  ...(projectId === undefined ? {} : { projectId }),
});

const note = (path: string, projectId?: string) =>
  createMemory({
    rawPath: path,
    content: "Weekly status goes out on Fridays.",
    scopeKey: keyIn(projectId),
    actor: { actor: "human", userId: ownerId },
  });

const refusal = async (
  promise: Promise<unknown>,
): Promise<{ status: number; code: string | undefined }> => {
  const error = await rejection(promise);
  if (!(error instanceof HTTPException)) throw error;
  return { status: error.status, code: parseApiError(error.message)?.code };
};

/** One chunk of a note in the assistant's index, to watch its audience. */
const vectorOf = async (memoryId: string, path: string) => {
  await db.insert(aiVectors).values({
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    sourceType: "memories",
    sourceId: memoryId,
    chunkIndex: 0,
    totalChunks: 1,
    content: "a chunk",
    contextualPrefix: "",
    metadata: {
      scope: "project",
      path,
      size_bytes: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  await refreshSourceVectorAcl({
    executor: db,
    sourceType: "memories",
    sourceId: memoryId,
  });
  const [row] = await db
    .select({ acl: aiVectors.aclPrincipals })
    .from(aiVectors)
    .where(eq(aiVectors.sourceId, memoryId));
  return row?.acl ?? null;
};

describe("a project's notes", () => {
  test("are the project's alone: another project and the team's settings do not see them", async () => {
    const created = await note("/memories/project/decisions.md", projectA);

    expect(
      await findMemoryByPath({
        scope: "project",
        relativePath: "decisions.md",
        scopeKey: keyIn(projectA),
      }),
    ).not.toBeNull();
    expect(
      await findMemoryByPath({
        scope: "project",
        relativePath: "decisions.md",
        scopeKey: keyIn(projectB),
      }),
    ).toBeNull();

    // The team's own memory settings list a person's notes and the team's.
    const { memories } = await listMemoriesForUi({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: ownerId,
      limit: 50,
      offset: 0,
    });
    expect(memories.map((m) => m.id)).not.toContain(created.id);
    expect(
      await getMemoryContent({
        id: created.id,
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        currentUserId: ownerId,
      }),
    ).toBeNull();

    // The project lists its own, and only its own.
    const inA = await listProjectMemoriesForUi({
      organizationId: fx.organizationId,
      projectId: projectA,
      limit: 50,
      offset: 0,
    });
    expect(inA.memories.map((m) => m.id)).toEqual([created.id]);
    expect(inA.total).toBe(1);
    const inB = await listProjectMemoriesForUi({
      organizationId: fx.organizationId,
      projectId: projectB,
      limit: 50,
      offset: 0,
    });
    expect(inB.total).toBe(0);
    expect(
      await refusal(
        requireProjectMemoryContent({
          id: created.id,
          organizationId: fx.organizationId,
          projectId: projectB,
        }),
      ),
    ).toEqual({ status: 404, code: "MEMORY_FILE_NOT_FOUND" });
    expect(
      await getProjectMemoryHistory({
        memoryId: created.id,
        organizationId: fx.organizationId,
        projectId: projectB,
      }),
    ).toBeNull();
    const history = await getProjectMemoryHistory({
      memoryId: created.id,
      organizationId: fx.organizationId,
      projectId: projectA,
    });
    expect(history?.map((entry) => entry.operation)).toEqual(["create"]);
  });

  test("are indexed for the project's chats only", async () => {
    await note("/memories/project/decisions.md", projectA);
    await note("/memories/team/conventions.md");

    const teamChat = await buildMemoryIndexManifest(
      keyIn(),
      memoryNamespacesFor({}),
    );
    expect(teamChat).toContain("conventions.md");
    expect(teamChat).not.toContain("decisions.md");

    const projectChat = await buildMemoryIndexManifest(
      keyIn(projectA),
      memoryNamespacesFor({ projectId: projectA }),
    );
    expect(projectChat).toContain("/memories/project/");
    expect(projectChat).toContain("decisions.md");
    expect(projectChat).toContain("conventions.md");

    // Someone outside the team, in the project: the project's, not the team's.
    const outsider = await buildMemoryIndexManifest(
      keyIn(projectA),
      memoryNamespacesFor({ projectId: projectA, outsideTeam: true }),
    );
    expect(outsider).toContain("decisions.md");
    expect(outsider).not.toContain("conventions.md");
  });

  test("keep one path per project", async () => {
    await note("/memories/project/decisions.md", projectA);
    await note("/memories/project/decisions.md", projectB);
    expect(
      await refusal(note("/memories/project/decisions.md", projectA)),
    ).toMatchObject({ status: 409 });
  });

  test("name no project outside one", async () => {
    expect(await refusal(note("/memories/project/decisions.md"))).toEqual({
      status: 400,
      code: "MEMORY_NO_PROJECT",
    });
  });

  test("tie each scope to its owner in the database", async () => {
    const row = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      path: "raw.md",
      content: "x",
      sizeBytes: 1,
      createdByActor: "human" as const,
      lastModifiedByActor: "human" as const,
    };
    await rejection(db.insert(aiMemories).values({ ...row, scope: "project" }));
    await rejection(
      db
        .insert(aiMemories)
        .values({ ...row, scope: "team", projectId: projectA }),
    );
    await rejection(
      db.insert(aiMemories).values({
        ...row,
        scope: "project",
        projectId: projectA,
        userId: ownerId,
      }),
    );
  });

  test("are found in search by the people of the project, not by its team", async () => {
    const projectNote = await note("/memories/project/decisions.md", projectA);
    const teamNote = await note("/memories/team/conventions.md");
    expect(await vectorOf(projectNote.id, "decisions.md")).toEqual([projectA]);
    expect(await vectorOf(teamNote.id, "conventions.md")).toBeNull();
  });

  test("are cleared by whoever manages the project, and only them", async () => {
    await note("/memories/project/decisions.md", projectA);
    const kept = await note("/memories/team/conventions.md");

    expect(
      await refusal(
        deleteAllMemories({
          scopeKey: keyIn(projectA),
          scope: "project",
          canManageTeamMemory: true,
        }),
      ),
    ).toMatchObject({ status: 403 });

    const { deleted } = await deleteAllMemories({
      scopeKey: keyIn(projectA),
      scope: "project",
      canManageTeamMemory: false,
      canManageProjectMemory: true,
    });
    expect(deleted).toBe(1);
    const left = await db
      .select({ id: aiMemories.id })
      .from(aiMemories)
      .where(eq(aiMemories.teamId, fx.teamId));
    expect(left.map((m) => m.id)).toEqual([kept.id]);
  });

  test("leave with the project: their rows, history and vectors", async () => {
    const gone = await note("/memories/project/decisions.md", projectA);
    const stays = await note("/memories/team/conventions.md");
    await vectorOf(gone.id, "decisions.md");
    await vectorOf(stays.id, "conventions.md");

    await deleteProject({
      principal: await fx.principalOf(ownerId),
      projectId: projectA,
    });

    const notes = await db
      .select({ id: aiMemories.id })
      .from(aiMemories)
      .where(inArray(aiMemories.id, [gone.id, stays.id]));
    expect(notes.map((m) => m.id)).toEqual([stays.id]);
    const history = await db
      .select({ memoryId: aiMemoryHistory.memoryId })
      .from(aiMemoryHistory)
      .where(eq(aiMemoryHistory.teamId, fx.teamId));
    expect(history.map((h) => h.memoryId)).toEqual([stays.id]);
    const vectors = await db
      .select({ sourceId: aiVectors.sourceId })
      .from(aiVectors)
      .where(inArray(aiVectors.sourceId, [gone.id, stays.id]));
    expect(vectors.map((v) => v.sourceId)).toEqual([stays.id]);
  });
});

describe("an approved write at a root", () => {
  let seq = 0;
  const applyCreateFolder = async (conversationId: string, name: string) => {
    const [approval] = await db
      .insert(toolApprovalRequests)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        userId: ownerId,
        conversationId,
        turnId: "01a04698-d809-755c-89f7-c9e96397a94b",
        kind: "tool_call",
        lookupHash: `notes-${(seq++).toString()}`,
        status: "granted",
        payload: {
          toolName: "manageDrive",
          args: { action: "createFolder", name, parentFolderId: null },
        },
      })
      .returning();
    if (!approval) throw new Error("fixture: no approval");
    const result = await toolCallHandler.execute({ approval });
    expect(result).toMatchObject({ ok: true });
    const [folder] = await db
      .select({ projectId: folders.projectId })
      .from(folders)
      .where(eq(folders.name, name));
    return folder?.projectId ?? null;
  };

  test("lands at the root of the chat's project", async () => {
    const teamChat = await fx.createConversation();
    const projectChat = await fx.createConversation({ projectId: projectA });
    expect(await applyCreateFolder(teamChat.id, "Team folder")).toBeNull();
    expect(await applyCreateFolder(projectChat.id, "Project folder")).toBe(
      projectA,
    );
  });

  test("lands in the project of the workflow a run belongs to", async () => {
    const [workflow] = await db
      .insert(workflows)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        projectId: projectA,
        name: "Weekly status",
        triggerType: "manual",
        createdByUserId: ownerId,
        playbook: {
          goal: "Send the weekly status",
          tasks: [
            {
              key: "only-task",
              title: "Nothing",
              description: "",
              instructions: "Nothing to do.",
            },
          ],
        },
      })
      .returning({ id: workflows.id });
    if (!workflow) throw new Error("fixture: no workflow");
    const runChat = await fx.createConversation({ agentType: "workflow" });
    await db.insert(workflowRuns).values({
      workflowId: workflow.id,
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      triggerType: "manual",
      conversationId: runChat.id,
    });
    expect(await applyCreateFolder(runChat.id, "Run folder")).toBe(projectA);
  });
});
