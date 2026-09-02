import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import db from "../../../src/db";
import { modelAdminActions, modelLiveState } from "../../../src/db/schema";
import type { LiveModelState } from "../../../src/model-registry/types";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * The operator journal — `model_admin_actions`.
 *
 * `services/model-registry/operations.ts` stays a unit test: every verdict in
 * it comes from `admin` / `breaker` / `add-from-catalogue`, all deliberately
 * doubled, and `db` appears there only to capture this one insert. That makes
 * its fake a SILENCER rather than a stand-in, which is legitimate — with one
 * hole it cannot close: whether the row it captures can actually be written.
 *
 * The journal is the only record of who did what to the fleet, and its
 * `record()` swallows its own failures on purpose, so a column that rejected
 * the payload would leave no trace anywhere but a log line nobody reads. Hence
 * this file: small, and about the INSERT alone.
 *
 * The refusal case matters as much as the success. "Someone tried to retire
 * the chatbot's model and was stopped" is precisely the line worth finding
 * weeks later, and a success-only journal would not have it.
 */

let fx: WorkspaceFixture;
let invalidations = 0;

await mockModule("../../src/services/model-registry/live", {
  invalidateLiveRegistry: () => {
    invalidations += 1;
    return Promise.resolve();
  },
});

const { promoteModel, retireModelOperation } =
  await import("../../../src/services/model-registry/operations");

let createdKeys: string[] = [];

const seedModel = async (
  overrides: Partial<LiveModelState> = {},
): Promise<string> => {
  const profileKey = `it-${randomUUID().slice(0, 8)}`;
  createdKeys.push(profileKey);
  await db.insert(modelLiveState).values({
    profileKey,
    status: "candidate",
    transport: "gateway",
    enabled: false,
    modelIds: { gateway: "acme/m1" },
    providerPool: {},
    effectiveContextLength: 128_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 4 },
    boundRoles: [],
    source: "sync",
    ...overrides,
  });
  return profileKey;
};

const journalFor = async (profileKey: string) =>
  db
    .select({
      action: modelAdminActions.action,
      outcome: modelAdminActions.outcome,
      userId: modelAdminActions.userId,
      payload: modelAdminActions.payload,
    })
    .from(modelAdminActions)
    .where(eq(modelAdminActions.profileKey, profileKey))
    .orderBy(asc(modelAdminActions.id));

beforeEach(async () => {
  invalidations = 0;
  createdKeys = [];
  fx = await createWorkspaceFixture();
});

afterEach(async () => {
  if (createdKeys.length > 0) {
    await db
      .delete(modelAdminActions)
      .where(inArray(modelAdminActions.profileKey, createdKeys));
    await db
      .delete(modelLiveState)
      .where(inArray(modelLiveState.profileKey, createdKeys));
  }
  await fx.cleanup();
});

describe("model_admin_actions", () => {
  test("a successful operation lands a row the schema accepts", async () => {
    const key = await seedModel();

    await promoteModel({
      profileKey: key,
      actor: { kind: "operator", userId: fx.userIds[0] },
    });

    const rows = await journalFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("promote");
    expect(rows[0]?.outcome).toBe("promoted");
    // The `user_id` FK is why an operator's id has to be a REAL user: a fake
    // that captured the insert could carry "user-1" forever, and the first
    // real click would violate the constraint and be swallowed by `record()`.
    expect(rows[0]?.userId).toBe(fx.userIds[0]);
    expect(rows[0]?.payload).not.toBeNull();
  });

  test("a REFUSAL is journalled too", async () => {
    const key = await seedModel({
      status: "published",
      enabled: true,
      boundRoles: ["chatbot-flagship"],
    });

    await retireModelOperation({
      profileKey: key,
      actor: { kind: "operator", userId: fx.userIds[0] },
    });

    const rows = await journalFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("retire");
    expect(rows[0]?.outcome).toBe("refused-bound-roles");
  });

  test("a machine actor writes no user, and the row still lands", async () => {
    // `userId` is nullable precisely so the sync and the breaker can journal.
    // A NOT NULL there would have made every automatic action unlogged, and
    // silently, because `record()` never throws.
    const key = await seedModel();

    await promoteModel({ profileKey: key, actor: { kind: "sync" } });

    const rows = await journalFor(key);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
  });
});
