import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import db from "../../../src/db";
import { domainEvents } from "../../../src/db/schema";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * What the agent's SQL tool can read of the journal.
 *
 * The tool connects as `fretik_sql_tool` and is scoped by row-level security.
 * This suite runs the query AS that role — `SET LOCAL ROLE` inside a
 * transaction, with the same transaction-local GUCs `runReadonlyQuery` sets —
 * because the policy is the only thing that decides, and a test running as the
 * owner (which bypasses RLS) would pass with any policy at all.
 *
 * The rows differ in their TYPE alone: same team, same organization, same
 * actor. Only the family allowlist can tell them apart.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const journal = async (types: string[]): Promise<void> => {
  await db.insert(domainEvents).values(
    types.map((type) => ({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type,
      actorType: "user" as const,
      actorUserId: fx.userIds[0],
      payload: { preview: `private text of ${type}` },
    })),
  );
};

/** The event types the SQL tool sees for the fixture's team. */
const visibleToSqlTool = async (): Promise<string[]> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE fretik_sql_tool`);
    await tx.execute(
      sql`SELECT set_config('fretik.team_id', ${fx.teamId}, true), set_config('fretik.organization_id', ${fx.organizationId}, true)`,
    );
    const result = await tx.execute<{ type: string }>(
      sql`SELECT type FROM domain_events ORDER BY type`,
    );
    return result.rows.map((row) => row.type);
  });

describe("the SQL tool reads the content journal, not private activity", () => {
  test("record and document events are visible; chat, memory, episode and workflow ones are not", async () => {
    await journal([
      "record.created",
      "document.uploaded",
      "chat.turn",
      "memory.created",
      "episode.created",
      "workflow.run.completed",
      "conversation.created",
    ]);

    expect(await visibleToSqlTool()).toEqual([
      "document.uploaded",
      "record.created",
    ]);
  });
});
