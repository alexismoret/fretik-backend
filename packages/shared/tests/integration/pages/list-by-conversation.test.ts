import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { listPages } from "../../../src/services/pages/retrieve";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * `listPages` narrowed to one conversation — what the chat header's Pages
 * control counts, and what its panel lists.
 *
 * The control only shows when the count is not zero, so a filter that let
 * anything through would put a Pages button on every conversation of a team
 * that has ever built one. Each case therefore sets the page it must keep
 * beside the pages it must drop: one another conversation built, one no
 * conversation built, and one this very conversation built and later archived.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

describe("listPages by conversation", () => {
  test("keeps only the pages the conversation built", async () => {
    const here = await fx.createConversation();
    const elsewhere = await fx.createConversation();
    const built = await fx.createPage({ sourceConversationId: here.id });
    await fx.createPage({ sourceConversationId: elsewhere.id });
    await fx.createPage();
    await fx.createPage({
      sourceConversationId: here.id,
      archivedAt: new Date(),
    });

    const pages = await listPages({
      teamId: fx.teamId,
      sourceConversationId: here.id,
    });

    expect(pages.map((p) => p.id)).toEqual([built.id]);
  });

  test("a conversation that built nothing lists nothing", async () => {
    const quiet = await fx.createConversation();
    const busy = await fx.createConversation();
    await fx.createPage({ sourceConversationId: busy.id });

    const pages = await listPages({
      teamId: fx.teamId,
      sourceConversationId: quiet.id,
    });

    expect(pages).toEqual([]);
  });

  test("without a conversation the listing is still the whole team's", async () => {
    const conversation = await fx.createConversation();
    const fromChat = await fx.createPage({
      sourceConversationId: conversation.id,
    });
    const standalone = await fx.createPage();

    const ids = (await listPages({ teamId: fx.teamId })).map((p) => p.id);

    expect(ids).toContain(fromChat.id);
    expect(ids).toContain(standalone.id);
  });
});
