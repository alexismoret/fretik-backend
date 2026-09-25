import type { HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { redis } from "@fretik/shared/lib/redis";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { chatbotRateLimitMiddleware } from "../../../src/middlewares/chatbot-rate-limit";
import {
  createMemoryTestFixture,
  type MemoryTestFixture,
} from "../lib/db-fixtures";

/**
 * Which bucket a chat turn counts in. The turn runs on its CONVERSATION's
 * team — its settings, its budget — whatever team the writer has open, so
 * that is where it is counted; a guest, who has no team, counts against the
 * project that invited them, and a body naming no conversation of the
 * organization falls back to the session's team, then to the person. Nobody
 * is ever unmetered.
 *
 * The middleware runs in front of a stub route, with the context the auth
 * middleware would have set; the buckets are real Redis keys.
 */

let fx: MemoryTestFixture;

beforeEach(async () => {
  fx = await createMemoryTestFixture();
});

afterEach(async () => {
  await fx.cleanup();
});

const appFor = (context: { userId: string; teamId: string | null }) => {
  const app = new Hono<HonoLoggedAppType>();
  app.use("*", async (c, next) => {
    c.set("user", { id: context.userId } as never);
    c.set(
      "team",
      context.teamId === null ? null : ({ id: context.teamId } as never),
    );
    c.set("principal", {
      kind: "user",
      userId: context.userId,
      organizationId: fx.organizationId,
    } as never);
    await next();
  });
  app.use("/stream", chatbotRateLimitMiddleware);
  app.post("/stream", async (c) => {
    // The handler reads the body again, as the real one does.
    const body: unknown = await c.req.json();
    return c.json({ body }, 200);
  });
  return app;
};

const post = (app: Hono<HonoLoggedAppType>, body: unknown) =>
  app.request("/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const countIn = async (key: string): Promise<number> => redis.zcard(key);

describe("the chat rate limit", () => {
  test("counts a turn against its conversation's team, not the one open", async () => {
    const conversationId = await fx.createConversation();
    const otherTeam = randomUUID();
    const app = appFor({ userId: fx.userIds[0], teamId: otherTeam });

    const response = await post(app, { conversationId, messages: [] });

    expect(response.status).toBe(200);
    // The handler still reads the whole body.
    expect(await response.json()).toEqual({
      body: { conversationId, messages: [] },
    });
    expect(await countIn(`chatbot:rate:${fx.teamId}`)).toBe(1);
    expect(await countIn(`chatbot:rate:${otherTeam}`)).toBe(0);
  });

  test("counts a guest, who has no team, against the conversation's", async () => {
    const conversationId = await fx.createConversation();
    const guestId = randomUUID();
    const app = appFor({ userId: guestId, teamId: null });

    await post(app, { conversationId, messages: [] });

    expect(await countIn(`chatbot:rate:${fx.teamId}`)).toBe(1);
    expect(await countIn(`chatbot:rate:user:${guestId}`)).toBe(0);
  });

  test("never leaves a turn unmetered: with no team at all, the person counts", async () => {
    const personId = randomUUID();
    const app = appFor({ userId: personId, teamId: null });

    // A conversation of no organization of theirs names no team.
    await post(app, { conversationId: randomUUID(), messages: [] });

    expect(await countIn(`chatbot:rate:user:${personId}`)).toBe(1);
    await redis.del(`chatbot:rate:user:${personId}`);
  });
});
