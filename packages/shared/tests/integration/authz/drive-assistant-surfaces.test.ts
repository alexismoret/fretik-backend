import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { resolveAccessMany } from "../../../src/authz/access";
import { driveVisibility } from "../../../src/authz/drive-sql";
import type { UserPrincipal } from "../../../src/authz/principal";
import { teamAgentPrincipal } from "../../../src/authz/team-agent";
import db from "../../../src/db";
import {
  aiEpisodes,
  aiVectors,
  type DomainEvent,
  domainEvents,
  type Workflow,
} from "../../../src/db/schema";
import { refreshVectorAcls } from "../../../src/services/ai-vectors/acl";
import { bootstrapTeamWithBotUser } from "../../../src/services/auth/bot-user";
import { anchorTextToRecords } from "../../../src/services/collection-records/anchor";
import { DOCUMENT_COLLECTION_KEY } from "../../../src/services/collections/constants";
import { getDashboardActivity } from "../../../src/services/dashboard/get-activity";
import { listRecordActivityCandidates } from "../../../src/services/episodes/dreaming-candidates";
import { keepVisibleTriggerPairs } from "../../../src/services/workflows/keep-visible-trigger-pairs";
import { normalizeEntityName } from "../../../src/utils/normalizeEntityName";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { buildDriveTree, type DriveTree } from "../../lib/drive-tree";

/**
 * What the assistant and the team's shared surfaces learn of a file through
 * the record that mirrors it, and through the journal that names it: exactly
 * what their reader could open (the engine on `tests/lib/drive-tree.ts`).
 *
 *   - recall anchors the message on records — never on a hidden file's mirror;
 *   - the search index gives a mirror record its file's audience;
 *   - a team digest is written only for what the whole team can see, and a
 *     file kept from the team takes its digest with it;
 *   - a workflow hears of a file only when its identity can open it;
 *   - the home feed names a file or a folder only to those who can open it.
 */

let fx: WorkspaceFixture;
let tree: DriveTree;
let collectionId: string;
/** Mirror record ids by the tree path of their file. */
const mirrorOf = new Map<string, string>();

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  tree = await buildDriveTree(fx);
  await bootstrapTeamWithBotUser({
    teamId: fx.teamId,
    organizationId: fx.organizationId,
  });
  collectionId = (await fx.createCollection({ key: DOCUMENT_COLLECTION_KEY }))
    .id;
  for (const [path, documentId] of tree.documents) {
    const mirror = await fx.createRecord({
      collectionId,
      documentId,
      label: path,
      normalizedLabel: normalizeEntityName(path),
    });
    mirrorOf.set(path, mirror.id);
  }
});

afterAll(async () => {
  await tree.cleanup();
  await fx.cleanup();
});

const pathOfMirror = (id: string): string => tree.nameOf(mirrorOf, id);

const openFiles = async (principal: UserPrincipal): Promise<string[]> =>
  [
    ...(
      await resolveAccessMany(principal, "document", [
        ...tree.documents.values(),
      ])
    ).keys(),
  ]
    .map((id) => tree.nameOf(tree.documents, id))
    .sort();

describe("recall", () => {
  test("a message naming a file anchors on its mirror only for those who can open it", async () => {
    const text = "Compare root-restricted with root-owned-by-member and root";
    const anchored = async (userId: string): Promise<string[]> =>
      (
        await anchorTextToRecords({
          teamId: fx.teamId,
          drive: await driveVisibility(await fx.principalOf(userId), fx.teamId),
          text,
        })
      )
        .map((anchor) => pathOfMirror(anchor.recordId))
        .sort();

    expect(await anchored(tree.member)).toEqual([
      "root",
      "root-owned-by-member",
    ]);
    expect(await anchored(tree.owner)).toEqual(["root", "root-restricted"]);
  });
});

describe("the search index and the team's memory", () => {
  test("a mirror record's vectors carry its file's audience; a file kept from the team takes its digest with it", async () => {
    const restricted = mirrorOf.get("root-restricted") ?? "";
    const open = mirrorOf.get("root") ?? "";
    await db.insert(aiVectors).values(
      [restricted, open].map((recordId) => ({
        sourceType: "records" as const,
        sourceId: recordId,
        teamId: fx.teamId,
        organizationId: fx.organizationId,
        content: "a record card",
        contextualPrefix: "",
        chunkIndex: 0,
        totalChunks: 1,
        metadata: {
          collection_id: collectionId,
          collection_key: "k",
          label: "l",
        },
      })),
    );
    const [digest] = await db
      .insert(aiEpisodes)
      .values({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        kind: "record_activity",
        title: "What happened to the restricted file",
        summary: "…",
        anchorRecordId: restricted,
        contentHash: crypto.randomUUID(),
        metadata: {},
      })
      .returning({ id: aiEpisodes.id });

    await refreshVectorAcls({
      executor: db,
      type: "document",
      ids: [
        tree.documents.get("root-restricted") ?? "",
        tree.documents.get("root") ?? "",
      ],
    });

    const vectors = await db
      .select({ id: aiVectors.sourceId, acl: aiVectors.aclPrincipals })
      .from(aiVectors)
      .where(
        and(
          eq(aiVectors.sourceType, "records"),
          inArray(aiVectors.sourceId, [restricted, open]),
        ),
      );
    expect(
      Object.fromEntries(vectors.map((v) => [pathOfMirror(v.id), v.acl])),
    ).toEqual({ "root-restricted": [tree.owner], root: null });

    const [after] = await db
      .select({ state: aiEpisodes.state })
      .from(aiEpisodes)
      .where(eq(aiEpisodes.id, digest?.id ?? ""));
    expect(after?.state).toBe("demoted");
  });

  test("a team digest is only ever proposed for what the whole team can see", async () => {
    await db.insert(domainEvents).values(
      [...mirrorOf.values()].map((recordId) => ({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        type: "record.updated",
        actorType: "user" as const,
        actorUserId: tree.owner,
        subjectRecordId: recordId,
        payload: {},
      })),
    );
    const candidates = await listRecordActivityCandidates({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      minEvents: 1,
      windowDays: 7,
      limit: 100,
    });
    const agent = await teamAgentPrincipal(fx);
    expect(
      candidates
        .map((c) => pathOfMirror(c.recordId))
        .filter((path) => tree.documents.has(path))
        .sort(),
    ).toEqual(await openFiles(agent));
  });
});

describe("workflow triggers", () => {
  const workflow = (userId: string | null): Workflow =>
    ({
      id: crypto.randomUUID(),
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId,
    }) as Workflow;

  const event = (payload: Record<string, unknown>, subjectType: string) =>
    ({
      id: crypto.randomUUID(),
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: `${subjectType}.uploaded`,
      subjectType,
      subjectRecordId: null,
      payload,
    }) as unknown as DomainEvent;

  test("an event about a file or a folder starts only the workflows whose identity can open it", async () => {
    const team = workflow(null);
    const members = workflow(tree.member);
    const gone = crypto.randomUUID();
    const events = {
      root: event({ documentId: tree.documents.get("root") }, "document"),
      restricted: event(
        { documentId: tree.documents.get("root-restricted") },
        "document",
      ),
      membersOwn: event(
        { documentId: tree.documents.get("root-owned-by-member") },
        "document",
      ),
      closedFolder: event({ folderId: tree.folders.get("closed") }, "folder"),
      goneOpen: event({ documentId: gone, teamOpen: true }, "document"),
      goneKept: event({ documentId: gone, teamOpen: false }, "document"),
    };
    const pairs = Object.entries(events).flatMap(([name, e]) => [
      { name: `team:${name}`, workflow: team, event: e },
      { name: `member:${name}`, workflow: members, event: e },
    ]);

    const kept = (await keepVisibleTriggerPairs(pairs))
      .map((pair) => pair.name)
      .sort();
    expect(kept).toEqual([
      "member:goneOpen",
      "member:membersOwn",
      "member:root",
      "team:goneOpen",
      "team:root",
    ]);
  });
});

describe("the home feed", () => {
  test("names a file or a folder only to those who can open it", async () => {
    await db.insert(domainEvents).values([
      ...(["root", "root-restricted", "root-owned-by-member"] as const).map(
        (path) => ({
          organizationId: fx.organizationId,
          teamId: fx.teamId,
          type: "document.uploaded",
          actorType: "user" as const,
          actorUserId: tree.owner,
          subjectType: "document",
          subjectRecordId: mirrorOf.get(path),
          payload: { documentId: tree.documents.get(path), filename: path },
        }),
      ),
      ...(["open", "closed"] as const).map((path) => ({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        type: "folder.created",
        actorType: "user" as const,
        actorUserId: tree.owner,
        subjectType: "folder",
        payload: { folderId: tree.folders.get(path), name: path },
      })),
    ]);

    const { items } = await getDashboardActivity({
      teamId: fx.teamId,
      principal: await fx.principalOf(tree.member),
      limit: 100,
    });
    const titlesOf = (type: string): string[] =>
      items
        .filter((item) => item.type === type)
        .map((item) => item.title)
        .sort();
    expect(titlesOf("document.uploaded")).toEqual([
      "root",
      "root-owned-by-member",
    ]);
    expect(titlesOf("folder.created")).toEqual(["open"]);
  });
});
