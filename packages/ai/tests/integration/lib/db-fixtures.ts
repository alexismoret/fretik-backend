/**
 * Disposable Postgres fixtures for the memory-service tests.
 *
 * Each suite spins up a fresh `organization` + `team` + 2 `user`s
 * + their `member` / `teamMember` rows, and tears it down via a
 * single `organization` DELETE — every dependent row cascades, so
 * we never leak rows across tests.
 *
 * The IDs are random per call so suites running in parallel (Bun
 * runs test files concurrently by default) cannot collide on path
 * uniqueness.
 *
 * Lives under `@fretik/ai/tests` — `@fretik/shared` is library-only
 * and stays test-free; the deployable packages own their test
 * harnesses.
 */
import db from "@fretik/shared/db";
import {
  aiConversations,
  member,
  organization,
  team,
  teamMember,
  user,
} from "@fretik/shared/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export interface MemoryTestFixture {
  organizationId: string;
  teamId: string;
  /** Two users in the same team — used for cross-user RGPD checks. */
  userIds: [string, string];
  /**
   * Creates a fresh `ai_conversations` row scoped to the fixture
   * and returns its id. Lets a test simulate an agent write inside
   * an existing turn without spinning up the full chatbot pipeline.
   */
  createConversation: (args?: { userId?: string }) => Promise<string>;
  /** Removes the org + cascades everything created under it. */
  cleanup: () => Promise<void>;
}

const tag = () => randomUUID().slice(0, 8);

export const createMemoryTestFixture = async (): Promise<MemoryTestFixture> => {
  const suffix = tag();

  const [org] = await db
    .insert(organization)
    .values({
      name: `eval-org-${suffix}`,
      slug: `eval-org-${suffix}`,
      createdAt: new Date(),
    })
    .returning({ id: organization.id });
  if (!org) throw new Error("fixture: failed to insert organization");

  const [t] = await db
    .insert(team)
    .values({
      name: `eval-team-${suffix}`,
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
        email: `tester-a-${suffix}@example.test`,
        emailVerified: true,
      },
      {
        name: `Tester B ${suffix}`,
        email: `tester-b-${suffix}@example.test`,
        emailVerified: true,
      },
    ])
    .returning({ id: user.id });
  const userA = userRows[0];
  const userB = userRows[1];
  if (!userA || !userB) {
    throw new Error("fixture: failed to insert two users");
  }

  // Better-Auth requires a `member` row (org membership) and a
  // `teamMember` row (team membership) before a user can interact
  // with the team in production. The services don't enforce
  // membership themselves (the auth middleware does, upstream), but
  // seeding them keeps the fixture realistic.
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

  const createConversation: MemoryTestFixture["createConversation"] = async (
    args,
  ) => {
    const [row] = await db
      .insert(aiConversations)
      .values({
        organizationId: org.id,
        teamId: t.id,
        userId: args?.userId ?? userA.id,
        agentType: "chatbot",
        title: `[test] ${suffix}`,
      })
      .returning({ id: aiConversations.id });
    if (!row) throw new Error("fixture: failed to insert ai_conversations row");
    return row.id;
  };

  const cleanup = async () => {
    // Cascading delete — every FK to organization is set to ON
    // DELETE CASCADE, so this single statement clears: team,
    // teamMember, member, ai_conversations, ai_messages, ai_memories,
    // ai_memory_history, …
    await db.delete(organization).where(eq(organization.id, org.id));
    // user rows are NOT FK'd to organization (Better-Auth model);
    // tear them down explicitly so a re-run of the suite doesn't
    // collide on the unique email constraint.
    await db.delete(user).where(eq(user.id, userA.id));
    await db.delete(user).where(eq(user.id, userB.id));
  };

  return {
    organizationId: org.id,
    teamId: t.id,
    userIds: [userA.id, userB.id],
    createConversation,
    cleanup,
  };
};
