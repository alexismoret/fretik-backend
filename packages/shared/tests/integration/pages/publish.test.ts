import "@hono/zod-openapi";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../../src/db";
import { pages } from "../../../src/db/schema";
import { redis } from "../../../src/lib/redis";
import type { PageCompiled, PageDefinition } from "../../../src/schemas/pages";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";
import { mockModule } from "../../lib/mock-module";

/**
 * Publishing, revoking, and the anonymous door.
 *
 * What gets FROZEN (the definition, compiled code included) versus what stays
 * live (the data); that a re-publish keeps the token so a shared link never
 * breaks; and that unpublishing clears the token so a revoked link is
 * indistinguishable from one that never existed.
 *
 * This ran against a faked `db` until 2026-09-02. The fake re-implemented
 * `pages.findFirst` as a JavaScript match on `id` OR `publicToken` and knew
 * nothing else, so the two predicates that decide who may publish — `teamId`
 * and the visibility clause spread in beside it — were absent from every test
 * in the file. `resolvePageAccess` is the only fully anonymous surface in the
 * product, and its lookup was being asserted against a hand-written matcher.
 *
 * `pageVisibilityWhere` had four tests of its own that compared the returned
 * OBJECT to a literal. They are gone: the clause is spread into a real query
 * here, so what is asserted is which pages a member, an admin and an internal
 * caller can actually reach.
 *
 * The AI service stays doubled — it is a process boundary, and `refreshPageVectors`
 * is fire-and-forget, so left real its rejection would surface inside whichever
 * file happens to be running when the connection gives up. Redis is REAL: the
 * cache drop is asserted by seeding a key under the published token's prefix
 * and finding it gone, which also proves the prefix matches the keys the public
 * route actually writes.
 */

const compiled = (): PageCompiled => ({
  js: 'import { mountPage } from "#fretik/sdk";',
  css: ".p-4{padding:1rem}",
  runtimeVersion: "v1",
  sourceHash: "a".repeat(64),
  compiledAt: "2026-01-01T00:00:00.000Z",
});

/** A publishable page: real source AND a stored compile. */
const readyDefinition = (text = "Hello"): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: {
    source: `<template><h1>${text}</h1></template>`,
    compiled: compiled(),
  },
});

const vectorizeCalls: { sourceId: string; content: string }[] = [];

await mockModule("../../src/lib/ai-service", {
  callAiService: (path: string, body: unknown) => {
    const payload = body as { sourceId: string; content: string };
    if (path === "/internal/vectorize") {
      vectorizeCalls.push({
        sourceId: payload.sourceId,
        content: payload.content,
      });
    }
    return Promise.resolve({ success: true });
  },
});

const { publishPage, unpublishPage } =
  await import("../../../src/services/pages/publish");
const { resolvePageAccess } =
  await import("../../../src/services/pages/resolve-page-access");
const { pageOwnerWriteError } =
  await import("../../../src/services/pages/visibility");
const { publicPageDefinitionCacheKey } =
  await import("../../../src/services/pages/public-cache");

let fx: WorkspaceFixture;
let otherFx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherFx = await createWorkspaceFixture();
  process.env["APP_URL"] = "https://app.example.com";
});

afterAll(async () => {
  await fx.cleanup();
  await otherFx.cleanup();
});

beforeEach(() => {
  vectorizeCalls.length = 0;
});

/**
 * Wait for the fire-and-forget re-index of ONE page to reach the AI service,
 * and return the calls it made.
 *
 * Two lessons are baked in here, both learned on 2026-09-02.
 *
 * POLLED, not ticked. This was a single macrotask, which sufficed while every
 * read the refresh makes was an in-memory double; against a real database it
 * is a race, and it lost about one run in three. More ticks would only move
 * the threshold — the thing to wait for is the call.
 *
 * BY PAGE ID, not by array length. `refreshPageVectors` is fire-and-forget, so
 * a call started by the PREVIOUS test can land after this one's `beforeEach`
 * has cleared the array — which showed up, under `randomize`, as "expected 1,
 * received 2". A neighbour's page id is not this page's, so filtering makes the
 * assertion independent of what else is in flight instead of merely unlikely
 * to collide with it.
 */
const waitForVectorize = async (
  sourceId: string,
  count: number,
): Promise<{ sourceId: string; content: string }[]> => {
  const deadline = Date.now() + 5_000;
  const mine = () => vectorizeCalls.filter((c) => c.sourceId === sourceId);
  while (mine().length < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `refreshPageVectors never reached the AI service for ${sourceId}: expected ${count.toString()} call(s), saw ${mine().length.toString()}`,
      );
    }
    await Bun.sleep(10);
  }
  return mine();
};

const seedPage = async (
  overrides: Partial<typeof pages.$inferInsert> = {},
): Promise<string> =>
  (await fx.createPage({ definition: readyDefinition(), ...overrides })).id;

const row = async (id: string) => {
  const found = await db.query.pages.findFirst({ where: { id } });
  if (!found) throw new Error(`page ${id} vanished`);
  return found;
};

const publish = (
  pageId: string,
  requester?: { userId: string; isAdmin: boolean },
) =>
  publishPage({
    pageId,
    teamId: fx.teamId,
    publishedByUserId: fx.userIds[0],
    ...(requester ? { requester } : {}),
  });

describe("publishPage — frozen definition, live data", () => {
  test("snapshots the current definition and mints a token", async () => {
    const id = await seedPage();

    const page = await publish(id);

    const stored = await row(id);
    expect(stored.publishedDefinition).toEqual(readyDefinition());
    expect(typeof stored.publicToken).toBe("string");
    expect(stored.publishedByUserId).toBe(fx.userIds[0]);
    expect(page.publicUrl).toBe(
      `https://app.example.com/p/${String(stored.publicToken)}`,
    );
  });

  test("re-indexes the search card, which now says the page is public", async () => {
    // The card's `Visibility:` line is the ONLY thing publishing changes in
    // that text, and the AI service skips the re-embed when the text is
    // unchanged — so a dropped refresh here leaves the assistant describing a
    // published page as internal.
    const id = await seedPage();

    await publish(id);
    const calls = await waitForVectorize(id, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.content).toContain("published at a public link");
  });

  test("re-publishing keeps the token so a shared link never breaks", async () => {
    const id = await seedPage();
    await publish(id);
    const first = (await row(id)).publicToken;

    await publish(id);

    expect((await row(id)).publicToken).toBe(first);
  });

  test("a later edit does not reach the published snapshot", async () => {
    const id = await seedPage();
    await publish(id);

    // The working definition moves on; the snapshot must not follow.
    await db
      .update(pages)
      .set({ definition: readyDefinition("Edited") })
      .where(eq(pages.id, id));

    const stored = await row(id);
    expect(JSON.stringify(stored.publishedDefinition)).toContain("Hello");
    expect(JSON.stringify(stored.publishedDefinition)).not.toContain("Edited");
    expect(JSON.stringify(stored.definition)).toContain("Edited");
  });

  test("a page with no code is refused, and its message names the fault", async () => {
    const id = await seedPage({
      definition: {
        version: 3,
        variables: [],
        datasets: [],
        operations: [],
        code: { source: "" },
      },
    });

    const failure = await rejection(publish(id));

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(400);
    // The gate's own wording is what an agent has to act on — pin it here so a
    // refactor that swallows it fails loudly.
    expect(failure.message).toContain("no code to publish");
    expect((await row(id)).publicToken).toBeNull();
  });

  test("code that never compiled cleanly is refused the same way", async () => {
    const id = await seedPage({
      definition: {
        version: 3,
        variables: [],
        datasets: [],
        operations: [],
        code: { source: "<template><h1>Hello</h1></template>" },
      },
    });

    const failure = await rejection(publish(id));

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(400);
    expect(failure.message).toContain("never compiled");
    expect((await row(id)).publicToken).toBeNull();
  });

  test("an unknown page id is a 404, not a silent no-op", async () => {
    const failure = await rejection(
      publish("01a00000-0000-7000-8000-0000000000ff"),
    );

    expect(failure).toBeInstanceOf(HTTPException);
    expect(failure instanceof HTTPException && failure.status).toBe(404);
  });

  test("publishing drops the public cache so the link goes live at once", async () => {
    const id = await seedPage();
    await publish(id);
    const token = (await row(id)).publicToken ?? "";
    // A viewer has since cached the OLD definition under this token.
    await redis.set(publicPageDefinitionCacheKey(token), "stale", "EX", 60);

    await publish(id);

    expect(await redis.get(publicPageDefinitionCacheKey(token))).toBeNull();
  });
});

describe("who may publish — team and visibility, in the same query", () => {
  test("another team's page is a 404, whatever its id", async () => {
    // The fake this replaced matched on `id` alone, so `teamId` was in the
    // service and in no test: a page id leaked between workspaces would have
    // published someone else's page to the open internet.
    const foreign = await otherFx.createPage({
      definition: readyDefinition(),
    });

    const failure = await rejection(publish(foreign.id));

    expect(failure instanceof HTTPException && failure.status).toBe(404);
    expect((await row(foreign.id)).publicToken).toBeNull();
  });

  test("a member cannot publish a colleague's PRIVATE page", async () => {
    const id = await seedPage({ userId: fx.userIds[0] });

    const failure = await rejection(
      publish(id, { userId: fx.userIds[1], isAdmin: false }),
    );

    expect(failure instanceof HTTPException && failure.status).toBe(404);
    expect((await row(id)).publicToken).toBeNull();
  });

  test("a member CAN publish a team-shared page", async () => {
    const id = await seedPage({ userId: null });

    await publish(id, { userId: fx.userIds[1], isAdmin: false });

    expect((await row(id)).publicToken).not.toBeNull();
  });

  test("an org admin publishes anything in the team, for governance", async () => {
    const id = await seedPage({ userId: fx.userIds[0] });

    await publish(id, { userId: fx.userIds[1], isAdmin: true });

    expect((await row(id)).publicToken).not.toBeNull();
  });

  test("no requester means system trust — every page in the team", async () => {
    const id = await seedPage({ userId: fx.userIds[0] });

    await publish(id);

    expect((await row(id)).publicToken).not.toBeNull();
  });

  test("a page may be team-shared or private to the writer, never to someone else", () => {
    // The write-side half of the same doctrine, and genuinely pure.
    expect(pageOwnerWriteError(null, "user-1")).toBeNull();
    expect(pageOwnerWriteError(undefined, "user-1")).toBeNull();
    expect(pageOwnerWriteError("user-1", "user-1")).toBeNull();
    expect(pageOwnerWriteError("user-2", "user-1")).toContain(
      "can't be scoped to another user",
    );
  });
});

describe("unpublishPage — a revoked link is indistinguishable from none", () => {
  test("clears the token and the snapshot together", async () => {
    const id = await seedPage();
    await publish(id);
    const token = (await row(id)).publicToken ?? "";
    await redis.set(publicPageDefinitionCacheKey(token), "stale", "EX", 60);

    const page = await unpublishPage({ pageId: id, teamId: fx.teamId });

    const stored = await row(id);
    expect(stored.publicToken).toBeNull();
    expect(stored.publishedDefinition).toBeNull();
    expect(stored.publishedAt).toBeNull();
    expect(stored.publishedByUserId).toBeNull();
    expect(page.publicUrl).toBeNull();
    expect(await redis.get(publicPageDefinitionCacheKey(token))).toBeNull();
  });

  test("the revoked token stops resolving at once", async () => {
    const id = await seedPage();
    await publish(id);
    const token = (await row(id)).publicToken ?? "";
    expect((await resolvePageAccess({ token })).access).toBe("ready");

    await unpublishPage({ pageId: id, teamId: fx.teamId });

    expect(await resolvePageAccess({ token })).toEqual({
      access: "not_found",
    });
  });

  test("unpublishing a page that was never published still succeeds", async () => {
    const id = await seedPage();

    await unpublishPage({ pageId: id, teamId: fx.teamId });

    expect((await row(id)).publicToken).toBeNull();
  });

  test("another team's page cannot be unpublished", async () => {
    const foreign = await otherFx.createPage({
      definition: readyDefinition(),
    });
    await publishPage({
      pageId: foreign.id,
      teamId: otherFx.teamId,
      publishedByUserId: otherFx.userIds[0],
    });

    const failure = await rejection(
      unpublishPage({ pageId: foreign.id, teamId: fx.teamId }),
    );

    expect(failure instanceof HTTPException && failure.status).toBe(404);
    expect((await row(foreign.id)).publicToken).not.toBeNull();
  });

  test("re-indexes the card back to internal — revoking must reach search too", async () => {
    const id = await seedPage();
    await publish(id);
    await waitForVectorize(id, 1);

    await unpublishPage({ pageId: id, teamId: fx.teamId });
    // The SECOND call for this page — the array is not cleared, because the
    // count is what says the revoke re-indexed rather than the publish.
    const calls = await waitForVectorize(id, 2);

    expect(calls[1]?.content).toContain("internal only");
  });
});

describe("resolvePageAccess — the anonymous door", () => {
  test("serves the FROZEN definition, never the working one", async () => {
    const id = await seedPage();
    await publish(id);
    const token = (await row(id)).publicToken ?? "";
    await db
      .update(pages)
      .set({ definition: readyDefinition("Draft") })
      .where(eq(pages.id, id));

    const result = await resolvePageAccess({ token });

    expect(result.access).toBe("ready");
    const served =
      result.access === "ready" ? JSON.stringify(result.definition) : "";
    expect(served).toContain("Hello");
    expect(served).not.toContain("Draft");
  });

  test("an unknown token is not_found", async () => {
    const id = await seedPage();
    await publish(id);

    expect(await resolvePageAccess({ token: "token-nobody-minted" })).toEqual({
      access: "not_found",
    });
  });

  test("a page with a token but no snapshot is not_found, never a blank page", async () => {
    const id = await seedPage();
    await publish(id);
    const token = (await row(id)).publicToken ?? "";
    await db
      .update(pages)
      .set({ publishedDefinition: null })
      .where(eq(pages.id, id));

    expect(await resolvePageAccess({ token })).toEqual({
      access: "not_found",
    });
  });

  test("an unpublished page's id is not a token", async () => {
    // The lookup is by `publicToken`, and both columns are opaque strings. A
    // resolver that matched on either would hand out every unpublished page in
    // the product to anyone who guessed an id.
    const id = await seedPage();

    expect(await resolvePageAccess({ token: id })).toEqual({
      access: "not_found",
    });
  });
});
