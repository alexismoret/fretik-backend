import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import db from "../../../src/db";
import { organizationSettings } from "../../../src/db/schema";
import { redis } from "../../../src/lib/redis";
import {
  getOrganizationSandboxPolicy,
  organizationSandboxPolicyCacheKey,
  setOrganizationSandboxPolicy,
} from "../../../src/services/organization/sandbox-policy";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";

/**
 * The org's sandbox egress policy — stored once, read on every code-running
 * turn, and cached.
 *
 * Three things can only be proven against a real Postgres and a real Redis,
 * and each is a defect this file exists to catch:
 *
 *   - the write MERGES. A patch carries one field, and a blind overwrite would
 *     silently reset the other — here, turning an admin's domain list back to
 *     empty the next time somebody changed the mode.
 *   - the write is SCOPED. An upsert keyed on the wrong column, or a missing
 *     `organizationId`, would write another tenant's policy: the second
 *     workspace below is what makes that fail.
 *   - the write INVALIDATES. `getOrganizationSandboxPolicy` is a
 *     `selectOrCache`, so without the `redis.del` a saved setting would take
 *     effect only when the key happened to expire — which is exactly the shape
 *     of "I changed it and nothing happened".
 */

let fixture: WorkspaceFixture;
let other: WorkspaceFixture;

beforeAll(async () => {
  fixture = await createWorkspaceFixture();
  other = await createWorkspaceFixture();
});

afterAll(async () => {
  await fixture.cleanup();
  await other.cleanup();
});

beforeEach(async () => {
  await db
    .delete(organizationSettings)
    .where(eq(organizationSettings.organizationId, fixture.organizationId));
  await db
    .delete(organizationSettings)
    .where(eq(organizationSettings.organizationId, other.organizationId));
  await redis.del(
    organizationSandboxPolicyCacheKey(fixture.organizationId),
    organizationSandboxPolicyCacheKey(other.organizationId),
  );
});

describe("organization sandbox policy", () => {
  test("an org that never saved one reads the default", async () => {
    const policy = await getOrganizationSandboxPolicy(fixture.organizationId);
    expect(policy).toEqual({ egressMode: "packages", extraDomains: [] });
  });

  test("a patch is stored and read back", async () => {
    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: {
        egressMode: "packages_plus_domains",
        extraDomains: ["files.example.org"],
      },
    });

    expect(await getOrganizationSandboxPolicy(fixture.organizationId)).toEqual({
      egressMode: "packages_plus_domains",
      extraDomains: ["files.example.org"],
    });
  });

  test("a second patch merges into the first instead of replacing it", async () => {
    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: {
        egressMode: "packages_plus_domains",
        extraDomains: ["files.example.org"],
      },
    });
    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: { egressMode: "platform_only" },
    });

    const policy = await getOrganizationSandboxPolicy(fixture.organizationId);
    expect(policy.egressMode).toBe("platform_only");
    // The domain list survives a mode-only change: an admin switching back to
    // `packages_plus_domains` gets their list, not an empty one.
    expect(policy.extraDomains).toEqual(["files.example.org"]);
  });

  test("writing one organization's policy leaves another's alone", async () => {
    await setOrganizationSandboxPolicy({
      organizationId: other.organizationId,
      patch: { egressMode: "platform_only", extraDomains: ["theirs.example"] },
    });
    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: {
        egressMode: "packages_plus_domains",
        extraDomains: ["ours.example"],
      },
    });

    expect(await getOrganizationSandboxPolicy(other.organizationId)).toEqual({
      egressMode: "platform_only",
      extraDomains: ["theirs.example"],
    });
  });

  test("a save invalidates the cache the turn path reads through", async () => {
    // Fill the cache with the pre-save value, the way a chat turn would.
    await getOrganizationSandboxPolicy(fixture.organizationId);
    expect(
      await redis.exists(
        organizationSandboxPolicyCacheKey(fixture.organizationId),
      ),
    ).toBe(1);

    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: { egressMode: "platform_only" },
    });

    expect(
      (await getOrganizationSandboxPolicy(fixture.organizationId)).egressMode,
    ).toBe("platform_only");
  });

  test("a save creates the settings row when the org has none", async () => {
    // `organization_settings` is a 1:1 extension row, not guaranteed to exist
    // for an org created before the table did — so the setter upserts. An
    // INSERT-only version throws on the second save; an UPDATE-only one writes
    // nothing at all and reports success.
    await setOrganizationSandboxPolicy({
      organizationId: fixture.organizationId,
      patch: { egressMode: "platform_only" },
    });
    const row = await db.query.organizationSettings.findFirst({
      columns: { sandboxPolicy: true },
      where: { organizationId: fixture.organizationId },
    });
    expect(row?.sandboxPolicy).toEqual({
      egressMode: "platform_only",
      extraDomains: [],
    });
  });
});
