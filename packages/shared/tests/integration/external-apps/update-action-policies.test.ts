import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import { externalAppToolSnapshots } from "../../../src/db/schema";
import { updateConnection } from "../../../src/services/external-apps/connections/update";
import { mcpToolsToDescriptor } from "../../../src/services/external-apps/mcp/to-descriptor";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * `updateConnection`'s `actionPolicies` branch — where a team decides which of
 * a connected app's tools may run without an approval card.
 *
 * It validated the incoming action names against `getProvider(providerKey)`,
 * the boot-time registry of hand-written manifests. An MCP connection has no
 * entry there BY DESIGN: its provider key is a minted slug and its action
 * surface lives in the introspected snapshot. So every MCP connection answered
 * `404 EXTERNAL_APP_PROVIDER_NOT_FOUND / "Unknown provider: <slug>"` — while
 * the settings page happily rendered the very rows the PATCH then refused,
 * because the read path (`toConnectionDto`) already read the snapshot.
 *
 * The lookup that decides all of this is `getSnapshotForConnection`, whose
 * whole content is a `where` on `(providerKey, fingerprint, connectionId)` —
 * integration, not unit. A double returning "the snapshot" whatever the where
 * said would keep every assertion here green with the connection scoping
 * deleted, which is the leak that matters: one team's tool list validating
 * another team's policies.
 */

let fx: WorkspaceFixture;
let admin: string;

const FINGERPRINT = "deadbeef0001";

/**
 * The error CODE, not its prose. `throwHttpError` JSON-encodes `{code, message}`
 * into the `HTTPException` message — and the code is precisely what regressed:
 * these calls answered `EXTERNAL_APP_PROVIDER_NOT_FOUND`, which reads to a user
 * as "your app does not exist". Asserting on the sentence would let that come
 * back under a friendlier wording.
 */
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

/** The shape a real Directus-style MCP server produces: no annotations at all. */
const descriptor = mcpToolsToDescriptor({
  key: "acme-tms",
  displayName: "Acme TMS",
  categories: ["productivity"],
  tools: [
    { name: "items", inputSchema: { type: "object", properties: {} } },
    { name: "schema", inputSchema: { type: "object", properties: {} } },
  ],
});

/** An MCP connection with its snapshot in place — `mcpAuthKind` is the
 *  discriminator `isMcpConnection` keys off, so it is load-bearing here. */
const createMcpConnection = async (over?: {
  fingerprint?: string | null;
  teamId?: string;
}): Promise<{ id: string }> => {
  const conn = await fx.createConnection({
    providerKey: `acme-tms-${Bun.randomUUIDv7().slice(0, 8)}`,
    mcpAuthKind: "none",
    mcpServerUrl: "https://mcp.example.test/sse",
    toolFingerprint:
      over?.fingerprint === undefined ? FINGERPRINT : over.fingerprint,
    ...(over?.teamId !== undefined ? { teamId: over.teamId } : {}),
  });
  if (over?.fingerprint !== null) {
    await db.insert(externalAppToolSnapshots).values({
      providerKey: conn.providerKey,
      connectionId: conn.id,
      fingerprint: over?.fingerprint ?? FINGERPRINT,
      descriptor,
      sdkPy: "# stub",
      skillMd: "# skill",
    });
  }
  return conn;
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  [admin] = fx.userIds;
});

afterAll(async () => {
  await fx.cleanup();
});

describe("an MCP connection's tools are editable", () => {
  test("a snapshot action name is accepted and persisted", async () => {
    const conn = await createMcpConnection();
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      userId: admin,
      isOrgAdmin: true,
      actionPolicies: { items: "auto" },
    });
    expect(row.actionPolicies).toEqual({ items: "auto" });
  });

  test("resetting to null drops the override rather than storing it", async () => {
    const conn = await createMcpConnection();
    await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      userId: admin,
      isOrgAdmin: true,
      actionPolicies: { items: "auto", schema: "blocked" },
    });
    const row = await updateConnection({
      id: conn.id,
      teamId: fx.teamId,
      userId: admin,
      isOrgAdmin: true,
      actionPolicies: { items: null },
    });
    expect(row.actionPolicies).toEqual({ schema: "blocked" });
  });

  test("a name the snapshot does not carry is a 400, not a 404 about the provider", async () => {
    // The distinction is the whole bug: "unknown action" is actionable,
    // "unknown provider: acme-tms-1a2b" told the user their app did not exist.
    const conn = await createMcpConnection();
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        userId: admin,
        isOrgAdmin: true,
        actionPolicies: { not_a_tool: "auto" },
      }),
    );
    expect(codeOf(err)).toBe("VALIDATION_ERROR");
    expect(err.message).toContain("not_a_tool");
  });

  test("a connection still being introspected says so, and stays retryable", async () => {
    const conn = await createMcpConnection({ fingerprint: null });
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        userId: admin,
        isOrgAdmin: true,
        actionPolicies: { items: "auto" },
      }),
    );
    expect(codeOf(err)).toBe("EXTERNAL_APP_MCP_NOT_READY");
  });
});

describe("scoping", () => {
  test("another team's connection is not editable through this team", async () => {
    // Differs from the caller's rows in exactly one column — the team — which
    // is the only shape that fails when `teamId` leaves `getConnectionForCaller`.
    const other = await fx.createTeam();
    const theirs = await createMcpConnection({ teamId: other.id });
    const err = await rejection(
      updateConnection({
        id: theirs.id,
        teamId: fx.teamId,
        userId: admin,
        isOrgAdmin: true,
        actionPolicies: { items: "auto" },
      }),
    );
    expect(codeOf(err)).toBe("EXTERNAL_APP_CONNECTION_NOT_FOUND");
  });

  test("a non-admin cannot change a team connection's permissions", async () => {
    const conn = await createMcpConnection();
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        userId: admin,
        isOrgAdmin: false,
        actionPolicies: { items: "auto" },
      }),
    );
    expect(codeOf(err)).toBe("FORBIDDEN");
  });
});

describe("connection options", () => {
  test("an MCP connection is told it has none, not that its provider is unknown", async () => {
    const conn = await createMcpConnection();
    const err = await rejection(
      updateConnection({
        id: conn.id,
        teamId: fx.teamId,
        userId: admin,
        isOrgAdmin: true,
        options: { persona: "ops" },
      }),
    );
    expect(codeOf(err)).toBe("EXTERNAL_APP_MCP_UNSUPPORTED");
  });
});
