import db from "@fretik/shared/db";
import {
  aiConversations,
  collectionRecords,
  collections,
  member,
  organization,
  team,
  teamMember,
  user,
} from "@fretik/shared/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * A disposable workspace for this package's integration tests: organization,
 * team, one user, and the rows a journal event can point at.
 *
 * Torn down with one `organization` DELETE — everything reachable from it
 * cascades — so no test can leave a row for the next one to read. Ids are
 * random per call, so two runs against the same database cannot collide.
 *
 * The rows exist because a domain event's `conversation_id` and
 * `subject_record_id` are real foreign keys: a `chat.turn` with a made-up
 * conversation id does not test the sweep, it fails the INSERT.
 */

export interface JobsTestFixture {
  organizationId: string;
  teamId: string;
  userId: string;
  /** A conversation a `chat.turn` or a workflow run can be attributed to. */
  createConversation: () => Promise<string>;
  /** A record a `record.*` event can name as its subject. */
  createRecord: () => Promise<string>;
  cleanup: () => Promise<void>;
}

const tag = (): string => randomUUID().slice(0, 8);

export const createJobsTestFixture = async (): Promise<JobsTestFixture> => {
  const suffix = tag();

  const [org] = await db
    .insert(organization)
    .values({
      name: `jobs-it-${suffix}`,
      slug: `jobs-it-${suffix}`,
      createdAt: new Date(),
    })
    .returning({ id: organization.id });
  if (!org) throw new Error("fixture: failed to insert organization");

  const [t] = await db
    .insert(team)
    .values({
      name: `jobs-it-${suffix}`,
      organizationId: org.id,
      createdAt: new Date(),
    })
    .returning({ id: team.id });
  if (!t) throw new Error("fixture: failed to insert team");

  const [u] = await db
    .insert(user)
    .values({
      name: `Jobs Tester ${suffix}`,
      email: `jobs-it-${suffix}@example.test`,
      emailVerified: true,
    })
    .returning({ id: user.id });
  if (!u) throw new Error("fixture: failed to insert user");

  await db.insert(member).values({
    userId: u.id,
    organizationId: org.id,
    role: "owner",
    createdAt: new Date(),
  });
  await db
    .insert(teamMember)
    .values({ userId: u.id, teamId: t.id, createdAt: new Date() });

  const [collection] = await db
    .insert(collections)
    .values({
      organizationId: org.id,
      teamId: t.id,
      key: `jobs_it_${suffix}`,
      label: `Jobs IT ${suffix}`,
    })
    .returning({ id: collections.id });
  if (!collection) throw new Error("fixture: failed to insert collection");

  const createConversation = async (): Promise<string> => {
    const [row] = await db
      .insert(aiConversations)
      .values({
        organizationId: org.id,
        teamId: t.id,
        userId: u.id,
        agentType: "chatbot",
        title: `[test] ${tag()}`,
      })
      .returning({ id: aiConversations.id });
    if (!row) throw new Error("fixture: failed to insert conversation");
    return row.id;
  };

  const createRecord = async (): Promise<string> => {
    const label = `Record ${tag()}`;
    const [row] = await db
      .insert(collectionRecords)
      .values({
        organizationId: org.id,
        teamId: t.id,
        collectionId: collection.id,
        label,
        normalizedLabel: label.toLowerCase(),
      })
      .returning({ id: collectionRecords.id });
    if (!row) throw new Error("fixture: failed to insert record");
    return row.id;
  };

  const cleanup = async (): Promise<void> => {
    await db.delete(organization).where(eq(organization.id, org.id));
    // `user` has no FK to organization (Better Auth owns that table), so the
    // cascade does not reach it.
    await db.delete(user).where(eq(user.id, u.id));
  };

  return {
    organizationId: org.id,
    teamId: t.id,
    userId: u.id,
    createConversation,
    createRecord,
    cleanup,
  };
};
