/**
 * `getMemoryActivityFeed` — team-shared panel feed. Asserts the RGPD
 * filter (`triggeringUserMessage` only on the caller's own writes),
 * the strict `scope='team'` boundary, and the `byActor='agent'` cut.
 */
import db from "@fretik/shared/db";
import { aiMessages } from "@fretik/shared/db/schema";
import { createMemory } from "@fretik/shared/services/ai-memory/create";
import { getMemoryActivityFeed } from "@fretik/shared/services/ai-memory/get-activity-feed";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../../lib/db-fixtures";

describe("getMemoryActivityFeed", () => {
  let fx: MemoryTestFixture;

  beforeAll(async () => {
    fx = await createMemoryTestFixture();
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  test("filters in only byActor='agent' on team-scope memories", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const conversationId = await fx.createConversation({ userId: userA });

    // 1 agent write on team — should appear.
    await createMemory({
      rawPath: "/memories/team/agent-team.md",
      content: "agent",
      scopeKey,
      actor: { actor: "agent", userId: userA, conversationId },
    });
    // 1 human write on team — should NOT appear (byActor='human').
    await createMemory({
      rawPath: "/memories/team/human-team.md",
      content: "human",
      scopeKey,
      actor: { actor: "human", userId: userA },
    });
    // 1 agent write on USER scope — must NOT appear in the team feed.
    await createMemory({
      rawPath: "/memories/user/private.md",
      content: "secret",
      scopeKey,
      actor: { actor: "agent", userId: userA, conversationId },
    });

    const result = await getMemoryActivityFeed({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 50,
      offset: 0,
    });
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("agent-team.md");
    expect(paths).not.toContain("human-team.md");
    expect(paths).not.toContain("private.md");
    expect(result.entries.every((e) => e.scope === "team")).toBe(true);
    expect(result.entries.every((e) => e.byActor === "agent")).toBe(true);
  });

  test("RGPD: triggeringUserMessage joined only when byUserId === caller", async () => {
    const [userA, userB] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const conversationId = await fx.createConversation({ userId: userA });

    // Seed a user message in the conversation BEFORE the audit row.
    await db.insert(aiMessages).values({
      conversationId,
      role: "user",
      parts: [{ type: "text", text: "Mémorise DHL stp" }] as never,
      metadata: null,
    });
    // Force the next insertions to land after the seeded message —
    // Postgres `defaultNow()` clock has 1ms resolution; small sleep
    // avoids the same-microsecond ordering tie.
    await new Promise((resolve) => setTimeout(resolve, 10));

    await createMemory({
      rawPath: "/memories/team/dhl-feed.md",
      content: "DHL",
      scopeKey,
      actor: { actor: "agent", userId: userA, conversationId },
    });

    // userA (the writer) sees their own triggering message.
    const fromA = await getMemoryActivityFeed({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 50,
      offset: 0,
    });
    const ownEntry = fromA.entries.find((e) => e.path === "dhl-feed.md");
    expect(ownEntry?.triggeringUserMessage).toBe("Mémorise DHL stp");

    // userB (peer) sees the entry but the message is nullified.
    const fromB = await getMemoryActivityFeed({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userB,
      limit: 50,
      offset: 0,
    });
    const peerEntry = fromB.entries.find((e) => e.path === "dhl-feed.md");
    expect(peerEntry).toBeDefined();
    expect(peerEntry?.triggeringUserMessage).toBeNull();
  });

  test("respects pagination and returns total count", async () => {
    const [userA] = fx.userIds;
    const scopeKey = {
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      userId: userA,
    };
    const conversationId = await fx.createConversation({ userId: userA });
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop -- deterministic ordering needed
      await createMemory({
        rawPath: `/memories/team/page-${i.toString()}.md`,
        content: `page ${i.toString()}`,
        scopeKey,
        actor: { actor: "agent", userId: userA, conversationId },
      });
    }
    const first = await getMemoryActivityFeed({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 2,
      offset: 0,
    });
    expect(first.entries.length).toBe(2);
    expect(first.total).toBeGreaterThanOrEqual(5);

    const second = await getMemoryActivityFeed({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      currentUserId: userA,
      limit: 2,
      offset: 2,
    });
    expect(second.entries.length).toBe(2);
    expect(second.entries[0]?.id).not.toBe(first.entries[0]?.id);
  });
});
