import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { updateConnection } from "../../../src/services/external-apps/connections/update";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * `updateConnection`'s `scope` branch — moving a connection between
 * team-shared (`user_id` NULL) and personal (`user_id` set).
 *
 * The asymmetry is the whole point and is what these assertions pin: sharing
 * YOUR OWN connection needs no permission (nobody else can even see it, so
 * only its owner can reach the call), while taking a SHARED one private takes
 * it away from every other member — so that direction is gated on being the
 * member who connected it, or governing the team's apps (its leads, and the
 * organization's admins, who lead every team).
 *
 * The fixture's first user owns the organization; the second is a member.
 *
 * Integration rather than unit because the decision reads two columns of the
 * row as it actually exists (`user_id`, `created_by_user_id`) through
 * `getConnectionForCaller`, whose visibility `where` is the other half of the
 * rule: a personal connection is invisible to everyone but its owner, so the
 * "can a teammate steal it" question is answered by the query, not the branch.
 */

let fx: WorkspaceFixture;
let owner: string;
let teammate: string;

const codeOf = (err: Error): string => {
  const parsed: unknown = JSON.parse(err.message);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "code" in parsed &&
    typeof parsed.code === "string"
  ) {
    return parsed.code;
  }
  throw new Error(`Not an error envelope: ${err.message}`);
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [owner, teammate] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("sharing a personal connection", () => {
  test("its owner shares it without needing any role", async () => {
    const conn = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      principal: await fx.principalOf(owner),
      scope: "team",
    });
    expect(row.userId).toBeNull();
  });

  test("a teammate cannot reach it at all", async () => {
    const conn = await fx.createConnection({
      userId: owner,
      createdByUserId: owner,
    });
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        principal: await fx.principalOf(teammate),
        scope: "team",
      }),
    );
    expect(codeOf(err)).toBe("EXTERNAL_APP_CONNECTION_NOT_FOUND");
  });
});

describe("taking a shared connection private", () => {
  test("the member who connected it may", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      principal: await fx.principalOf(owner),
      scope: "user",
    });
    expect(row.userId).toBe(owner);
  });

  test("an admin may, even without having connected it", async () => {
    const conn = await fx.createConnection({ createdByUserId: teammate });
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      principal: await fx.principalOf(owner),
      scope: "user",
    });
    expect(row.userId).toBe(owner);
  });

  test("any other member is refused", async () => {
    const conn = await fx.createConnection({ createdByUserId: owner });
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        principal: await fx.principalOf(teammate),
        scope: "user",
      }),
    );
    expect(codeOf(err)).toBe("ACCESS_DENIED");
  });
});

describe("re-sending the scope it already has", () => {
  test("is a no-op, not a permission error", async () => {
    // The settings form PATCHes every field it renders, so a plain rename by a
    // teammate carries `scope: "team"` — that must not read as an attempt to
    // un-share.
    const conn = await fx.createConnection({ createdByUserId: owner });
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      principal: await fx.principalOf(teammate),
      scope: "team",
      displayName: "Renamed by a teammate",
    });
    expect(row.userId).toBeNull();
    expect(row.displayName).toBe("Renamed by a teammate");
  });
});
