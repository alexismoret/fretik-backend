import "@hono/zod-openapi";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HTTPException } from "hono/http-exception";
import { getConnectionForCaller } from "../../../src/services/external-apps/connections/get-by-id";
import { listConnections } from "../../../src/services/external-apps/connections/list";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * A team's shared apps are its people's. Someone who takes part in one of
 * its projects without being one of them — their chats run in the team — has
 * their own connections there and none of the team's.
 */

let fx: WorkspaceFixture;
let memberId: string;
let outsiderId: string;
let shared: { id: string };
let outsidersOwn: { id: string };

beforeEach(async () => {
  fx = await createWorkspaceFixture();
  [memberId] = fx.userIds;
  outsiderId = await fx.addPerson({ inTeam: false });
  shared = await fx.createConnection();
  outsidersOwn = await fx.createConnection({ userId: outsiderId });
});

afterEach(async () => {
  await fx.cleanup();
});

describe("a team's shared connections", () => {
  test("are listed for its people, not for someone outside it", async () => {
    const forMember = await listConnections(fx.teamId, memberId);
    expect(forMember.map((c) => c.id)).toContain(shared.id);
    expect(forMember.map((c) => c.id)).not.toContain(outsidersOwn.id);

    const forOutsider = await listConnections(fx.teamId, outsiderId);
    expect(forOutsider.map((c) => c.id)).toEqual([outsidersOwn.id]);
  });

  test("are not opened by id for someone outside it", async () => {
    expect(
      (await getConnectionForCaller(shared.id, fx.teamId, memberId)).id,
    ).toBe(shared.id);
    const error = await rejection(
      getConnectionForCaller(shared.id, fx.teamId, outsiderId),
    );
    if (!(error instanceof HTTPException)) throw error;
    expect(error.status).toBe(404);
    expect(
      (await getConnectionForCaller(outsidersOwn.id, fx.teamId, outsiderId)).id,
    ).toBe(outsidersOwn.id);
  });
});
