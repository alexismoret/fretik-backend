/**
 * Disposable Postgres fixtures for this package's integration tests.
 *
 * Every suite builds its own workspace — organization, team, two users and
 * their memberships — and tears it down with a single `organization` DELETE.
 * Everything reachable from the organization cascades, so no test can leave a
 * row behind for the next one to read.
 *
 * TWO USERS, always. Most of what these tests exist to prove is that a query
 * scopes: that team B cannot see team A's rows, that a user-scoped connection
 * belongs to its owner. A fixture with one user cannot express the claim, and a
 * test that cannot express it silently becomes a test of something easier.
 *
 * Ids are random per call, so suites running against the same database — a
 * `--randomize` run, two developers, CI and a laptop — cannot collide.
 *
 * The fixture inserts through the real schema on purpose. A hand-written
 * `interface FakeRow` drifts from the table the day a column is added, and the
 * test keeps passing while production breaks; `$inferInsert` does not.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../src/db";
import {
  aiConversations,
  collectionRecords,
  collections,
  externalAppConnections,
  fieldDefinitions,
  linkTypes,
  links,
  member,
  organization,
  pages,
  team,
  teamMember,
  user,
} from "../../src/db/schema";
import { EMPTY_PAGE_DEFINITION } from "../../src/schemas/pages";

type CollectionInsert = typeof collections.$inferInsert;
type ConversationInsert = typeof aiConversations.$inferInsert;
type ConnectionInsert = typeof externalAppConnections.$inferInsert;
type PageInsert = typeof pages.$inferInsert;
type RecordInsert = typeof collectionRecords.$inferInsert;
type FieldInsert = typeof fieldDefinitions.$inferInsert;
type LinkTypeInsert = typeof linkTypes.$inferInsert;
type LinkInsert = typeof links.$inferInsert;

export interface WorkspaceFixture {
  organizationId: string;
  teamId: string;
  /** Two users in the same team — the second exists so scoping is testable. */
  userIds: [string, string];
  /**
   * A SECOND team in the SAME organization — the adversary a cross-team test
   * actually needs.
   *
   * A whole second workspace differs in organization, team AND collection, so a
   * refusal proves nothing about which predicate did the refusing. A row in
   * this team but in the first team's collection differs in exactly one column,
   * and is the only shape that can fail when `teamId` leaves a WHERE.
   */
  createTeam: () => Promise<{ id: string }>;
  /** A collection in this workspace. Defaults are enough to hang records off. */
  createCollection: (
    overrides?: Partial<CollectionInsert>,
  ) => Promise<{ id: string; key: string }>;
  /** A connected app in this workspace. Team-scoped unless `userId` is given. */
  createConnection: (
    overrides?: Partial<ConnectionInsert>,
  ) => Promise<{ id: string; providerKey: string }>;
  /** A page in this workspace. The definition renders nothing on purpose. */
  createPage: (overrides?: Partial<PageInsert>) => Promise<{ id: string }>;
  /**
   * A chat conversation in this workspace — what anything conversation-scoped
   * (approvals, tasks, turn state) hangs off, since those tables all carry a
   * FK to it.
   */
  createConversation: (
    overrides?: Partial<ConversationInsert>,
  ) => Promise<{ id: string }>;
  /**
   * A registry row in a collection. Only the system columns are written — the
   * per-collection `data.coll_<id>` extension table is the record SERVICES'
   * business, and nothing that reads by id needs it.
   */
  createRecord: (
    values: Pick<RecordInsert, "collectionId"> & Partial<RecordInsert>,
  ) => Promise<{ id: string }>;
  /** A team-scoped field definition on a collection. */
  createField: (
    values: Pick<FieldInsert, "collectionId" | "key" | "type"> &
      Partial<FieldInsert>,
  ) => Promise<{ id: string; key: string }>;
  /** A team-scoped link type. `normalizedKey` defaults to `key`. */
  createLinkType: (
    values: Pick<LinkTypeInsert, "key" | "fromCollectionId"> &
      Partial<LinkTypeInsert>,
  ) => Promise<{ id: string }>;
  /** An edge. Active unless the caller stamps `invalidatedAt` / `validTo`. */
  createLink: (
    values: Pick<LinkInsert, "linkTypeId" | "fromRecordId" | "toRecordId"> &
      Partial<LinkInsert>,
  ) => Promise<{ id: string }>;
  /** Drops the organization; every dependent row cascades with it. */
  cleanup: () => Promise<void>;
}

const tag = (): string => randomUUID().slice(0, 8);

export const createWorkspaceFixture = async (): Promise<WorkspaceFixture> => {
  const suffix = tag();

  const [org] = await db
    .insert(organization)
    .values({
      name: `it-org-${suffix}`,
      slug: `it-org-${suffix}`,
      createdAt: new Date(),
    })
    .returning({ id: organization.id });
  if (!org) throw new Error("fixture: failed to insert organization");

  const [t] = await db
    .insert(team)
    .values({
      name: `it-team-${suffix}`,
      organizationId: org.id,
      createdAt: new Date(),
    })
    .returning({ id: team.id });
  if (!t) throw new Error("fixture: failed to insert team");

  const userRows = await db
    .insert(user)
    .values([
      {
        name: `Tester A ${suffix}`,
        email: `it-a-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        name: `Tester B ${suffix}`,
        email: `it-b-${suffix}@example.test`,
        emailVerified: true,
      },
    ])
    .returning({ id: user.id });
  const [userA, userB] = userRows;
  if (!userA || !userB) throw new Error("fixture: failed to insert two users");

  await db.insert(member).values([
    {
      userId: userA.id,
      organizationId: org.id,
      role: "owner",
      createdAt: new Date(),
    },
    {
      userId: userB.id,
      organizationId: org.id,
      role: "member",
      createdAt: new Date(),
    },
  ]);
  await db.insert(teamMember).values([
    { userId: userA.id, teamId: t.id, createdAt: new Date() },
    { userId: userB.id, teamId: t.id, createdAt: new Date() },
  ]);

  const createCollection: WorkspaceFixture["createCollection"] = async (
    overrides,
  ) => {
    const key = overrides?.key ?? `it_coll_${tag()}`;
    const [row] = await db
      .insert(collections)
      .values({
        organizationId: org.id,
        teamId: t.id,
        key,
        label: `Collection ${key}`,
        ...overrides,
      })
      .returning({ id: collections.id, key: collections.key });
    if (!row) throw new Error("fixture: failed to insert collection");
    return row;
  };

  const createConnection: WorkspaceFixture["createConnection"] = async (
    overrides,
  ) => {
    const [row] = await db
      .insert(externalAppConnections)
      .values({
        organizationId: org.id,
        teamId: t.id,
        providerKey: `it-app-${tag()}`,
        displayName: "Integration app",
        status: "active",
        createdByUserId: userA.id,
        ...overrides,
      })
      .returning({
        id: externalAppConnections.id,
        providerKey: externalAppConnections.providerKey,
      });
    if (!row) throw new Error("fixture: failed to insert connection");
    return row;
  };

  const createPage: WorkspaceFixture["createPage"] = async (overrides) => {
    const [row] = await db
      .insert(pages)
      .values({
        organizationId: org.id,
        teamId: t.id,
        createdByUserId: userA.id,
        name: `Page ${tag()}`,
        definition: EMPTY_PAGE_DEFINITION,
        ...overrides,
      })
      .returning({ id: pages.id });
    if (!row) throw new Error("fixture: failed to insert page");
    return row;
  };

  const createConversation: WorkspaceFixture["createConversation"] = async (
    overrides,
  ) => {
    const [row] = await db
      .insert(aiConversations)
      .values({
        organizationId: org.id,
        teamId: t.id,
        userId: userA.id,
        title: `Conversation ${tag()}`,
        ...overrides,
      })
      .returning({ id: aiConversations.id });
    if (!row) throw new Error("fixture: failed to insert conversation");
    return row;
  };

  const createTeam: WorkspaceFixture["createTeam"] = async () => {
    const [row] = await db
      .insert(team)
      .values({
        name: `it-team-${tag()}`,
        organizationId: org.id,
        createdAt: new Date(),
      })
      .returning({ id: team.id });
    if (!row) throw new Error("fixture: failed to insert team");
    return row;
  };

  const createRecord: WorkspaceFixture["createRecord"] = async (values) => {
    const [row] = await db
      .insert(collectionRecords)
      .values({
        organizationId: org.id,
        teamId: t.id,
        label: `Record ${tag()}`,
        ...values,
      })
      .returning({ id: collectionRecords.id });
    if (!row) throw new Error("fixture: failed to insert record");
    return row;
  };

  const createField: WorkspaceFixture["createField"] = async (values) => {
    const [row] = await db
      .insert(fieldDefinitions)
      .values({
        organizationId: org.id,
        teamId: t.id,
        label: `Field ${values.key}`,
        ...values,
      })
      .returning({ id: fieldDefinitions.id, key: fieldDefinitions.key });
    if (!row) throw new Error("fixture: failed to insert field definition");
    return row;
  };

  const createLinkType: WorkspaceFixture["createLinkType"] = async (values) => {
    const [row] = await db
      .insert(linkTypes)
      .values({
        organizationId: org.id,
        teamId: t.id,
        normalizedKey: values.key,
        label: `Link ${values.key}`,
        ...values,
      })
      .returning({ id: linkTypes.id });
    if (!row) throw new Error("fixture: failed to insert link type");
    return row;
  };

  const createLink: WorkspaceFixture["createLink"] = async (values) => {
    const [row] = await db
      .insert(links)
      .values({ organizationId: org.id, teamId: t.id, ...values })
      .returning({ id: links.id });
    if (!row) throw new Error("fixture: failed to insert link");
    return row;
  };

  const cleanup = async (): Promise<void> => {
    await db.delete(organization).where(eq(organization.id, org.id));
    // `user` has no FK to organization (Better Auth owns that table), so the
    // cascade does not reach it — and a leftover row collides on the unique
    // email index the next time the same suffix is drawn.
    await db.delete(user).where(eq(user.id, userA.id));
    await db.delete(user).where(eq(user.id, userB.id));
  };

  return {
    organizationId: org.id,
    teamId: t.id,
    userIds: [userA.id, userB.id],
    createTeam,
    createCollection,
    createConnection,
    createPage,
    createConversation,
    createRecord,
    createField,
    createLinkType,
    createLink,
    cleanup,
  };
};
