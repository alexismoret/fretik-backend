import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { documents, folders, projects } from "../../../src/db/schema";
import type { DecisionResponse } from "../../../src/schemas/decisions";
import type { DecisionEvaluator } from "../../../src/services/decisions/remote";
import { emptyFactSheet } from "../../../src/services/facts/types";
import {
  autoFileDocument,
  FILING_QUESTION_ID,
  listFilingCandidates,
} from "../../../src/services/folders/auto-file";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The Drive filer moves a document nobody placed, so it may only move it
 * where the move changes nobody's access: into a folder open to the
 * document's whole place (its team's Drive, or its project's). A folder kept
 * to a few people would hide the document from the rest of the place, the
 * person who added it included; a folder of another place would take it out
 * of its own. The decision model is the only thing doubled.
 *
 *   open/              the team's, open
 *     sub/             open
 *     kept/            restricted
 *   closed/            restricted
 *     inner/           open itself, under a restricted folder
 *   project/           the project's, open
 *   project-closed/    the project's, restricted
 */

let ws: WorkspaceFixture;
let projectId: string;
const folderIds = new Map<string, string>();

const addFolder = async (
  key: string,
  shape: { parent?: string; restricted?: boolean; inProject?: boolean } = {},
): Promise<void> => {
  const [row] = await db
    .insert(folders)
    .values({
      teamId: ws.teamId,
      name: key,
      fullPath: `/${key}`,
      parentFolderId:
        shape.parent === undefined ? null : folderIds.get(shape.parent),
      projectId: shape.inProject === true ? projectId : null,
      accessRestricted: shape.restricted ?? false,
      ownerUserId: ws.userIds[0],
      createdById: ws.userIds[0],
    })
    .returning({ id: folders.id });
  if (!row) throw new Error("fixture: folder");
  folderIds.set(key, row.id);
};

/** A processed document at the root of the team's Drive, or of the project's. */
const addDocument = async (inProject: boolean): Promise<string> => {
  const [row] = await db
    .insert(documents)
    .values({
      teamId: ws.teamId,
      projectId: inProject ? projectId : null,
      folderId: null,
      status: "ready",
      originalFilename: `doc-${crypto.randomUUID().slice(0, 6)}.pdf`,
      fileSize: 10,
      mimeType: "application/pdf",
      fileHash: crypto.randomUUID(),
      ownerUserId: ws.userIds[0],
      uploadedById: ws.userIds[0],
    })
    .returning({ id: documents.id });
  if (!row) throw new Error("fixture: document");
  return row.id;
};

/** Answers the filing question with one folder, well above the bar. */
const choosing =
  (key: string, meanwhile?: () => Promise<void>): DecisionEvaluator =>
  async () => {
    await meanwhile?.();
    const choice = folderIds.get(key) ?? key;
    const response: DecisionResponse = {
      status: "answered",
      point: "drive.file",
      policy: {
        questionVersion: 2,
        thresholds: { folder: 0.75 },
        minChosenProbability: { folder: 0.5 },
      },
      answers: {
        [FILING_QUESTION_ID]: {
          type: "choice",
          choice,
          probabilities: { [choice]: 0.95 },
          confidence: 0.95,
        },
      },
      missing: [],
      transport: "openrouter",
      latencyMs: 10,
    };
    return response;
  };

const file = (documentId: string, evaluator: DecisionEvaluator) =>
  autoFileDocument({
    documentId,
    teamId: ws.teamId,
    organizationId: ws.organizationId,
    sheet: emptyFactSheet("document.uploaded"),
    evaluator,
  });

const folderOf = async (documentId: string): Promise<string | null> => {
  const row = await db.query.documents.findFirst({
    where: { id: documentId },
    columns: { folderId: true },
  });
  return row?.folderId ?? null;
};

const idOf = (key: string): string => {
  const id = folderIds.get(key);
  if (id === undefined) throw new Error(`fixture: no folder ${key}`);
  return id;
};

const namesOf = (candidates: readonly { id: string }[]): string[] =>
  candidates
    .map(
      ({ id }) =>
        [...folderIds].find(([, folderId]) => folderId === id)?.[0] ?? id,
    )
    .sort();

beforeAll(async () => {
  ws = await createWorkspaceFixture();
  const [project] = await db
    .insert(projects)
    .values({
      organizationId: ws.organizationId,
      teamId: ws.teamId,
      name: "Launch",
      ownerUserId: ws.userIds[0],
    })
    .returning({ id: projects.id });
  if (!project) throw new Error("fixture: project");
  projectId = project.id;

  await addFolder("open");
  await addFolder("open/sub", { parent: "open" });
  await addFolder("open/kept", { parent: "open", restricted: true });
  await addFolder("closed", { restricted: true });
  await addFolder("closed/inner", { parent: "closed" });
  await addFolder("project", { inProject: true });
  await addFolder("project-closed", { inProject: true, restricted: true });
});

afterAll(async () => {
  await ws.cleanup();
});

describe("the folders a document may be filed into", () => {
  test("a team document is offered the team's folders open to the whole team", async () => {
    expect(
      namesOf(
        await listFilingCandidates({ teamId: ws.teamId, projectId: null }),
      ),
    ).toEqual(["open", "open/sub"]);
  });

  test("a project document is offered its project's open folders, and only those", async () => {
    expect(
      namesOf(await listFilingCandidates({ teamId: ws.teamId, projectId })),
    ).toEqual(["project"]);
  });
});

describe("autoFileDocument", () => {
  test("files a team document into a folder open to the team", async () => {
    const documentId = await addDocument(false);
    const filed = await file(documentId, choosing("open/sub"));
    expect(filed?.folderId).toBe(idOf("open/sub"));
    expect(await folderOf(documentId)).toBe(idOf("open/sub"));
  });

  test("never files into a folder kept from part of the place", async () => {
    for (const key of ["open/kept", "closed", "closed/inner"]) {
      const documentId = await addDocument(false);
      expect(await file(documentId, choosing(key))).toBeNull();
      expect(await folderOf(documentId)).toBeNull();
    }
  });

  test("a project document never leaves its project, nor a team document its team", async () => {
    const inProject = await addDocument(true);
    expect(await file(inProject, choosing("open"))).toBeNull();
    expect(await folderOf(inProject)).toBeNull();

    const inTeam = await addDocument(false);
    expect(await file(inTeam, choosing("project"))).toBeNull();
    expect(await folderOf(inTeam)).toBeNull();

    expect((await file(inProject, choosing("project")))?.folderId).toBe(
      idOf("project"),
    );
  });

  test("a folder closed while the model answered is left alone", async () => {
    // Its own folder, so the suite's order cannot matter: once closed, it is
    // offered to nobody.
    await addFolder("late");
    const late = idOf("late");
    const documentId = await addDocument(false);
    const filed = await file(
      documentId,
      choosing("late", async () => {
        await db
          .update(folders)
          .set({ accessRestricted: true })
          .where(eq(folders.id, late));
      }),
    );
    expect(filed).toBeNull();
    expect(await folderOf(documentId)).toBeNull();
  });
});
