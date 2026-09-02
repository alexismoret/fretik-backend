import "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import db from "../../../src/db";
import type { PageDefinition } from "../../../src/schemas/pages";
import {
  teamConnectedProviderKeys,
  validatePageDefinitionConnections,
} from "../../../src/services/pages/validate-connections";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { rejection } from "../../lib/expect-rejection";

/**
 * `validatePageDefinitionConnections` — the one data-half check that REFUSES.
 *
 * It exists because the failure it catches is silent: a dataset over a provider
 * key nothing can match does not error at view time, it answers
 * `needs_connection`, which reads to everyone as "you are not connected". The
 * page then ships and can never load. Measured on a real WMS page, 2026-08-26.
 *
 * This ran as a unit test with a faked `db` until 2026-09-02, and the fake was
 * the problem: it re-implemented the `status` filter in JavaScript, so the test
 * named "only active connections count" asserted that the FAKE filtered. Delete
 * the `status: "active"` clause from the service and it still passed. Worse,
 * the fake ignored `teamId` entirely — the one predicate whose failure is a
 * cross-team leak. Both claims are now made against Postgres, and the leak has
 * a test of its own.
 *
 * No provider is registered in this process, so `listProviderKeys()` is empty —
 * which is exactly the arrangement that exercises the OTHER half of the known
 * set, the team's own connections. That union is what keeps a page over a
 * custom MCP server (whose key is minted at connect time and is in no registry)
 * from being refused.
 */

let fx: WorkspaceFixture;

beforeAll(async () => {
  fx = await createWorkspaceFixture();
});

afterAll(async () => {
  await fx.cleanup();
});

const definition = (extra: Partial<PageDefinition>): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "<template><div>x</div></template>" },
  ...extra,
});

const dataset = (providerKey?: string, connectionId?: string): PageDefinition =>
  definition({
    datasets: [
      {
        id: "stock",
        kind: "external",
        operation: "list_items",
        ...(providerKey !== undefined ? { providerKey } : {}),
        ...(connectionId !== undefined ? { connectionId } : {}),
      },
    ],
  });

const validate = (input: PageDefinition, teamId: string = fx.teamId) =>
  validatePageDefinitionConnections({ definition: input, teamId });

describe("what the team has is part of the catalogue", () => {
  test("a key the team is connected to passes, registry or not", async () => {
    const { providerKey } = await fx.createConnection();
    expect((await validate(dataset(providerKey))).errors).toEqual([]);
  });

  test("an MCP slug the team connected passes — no registry could know it", async () => {
    const { providerKey } = await fx.createConnection({
      providerKey: `notion-mcp-${Math.random().toString(16).slice(2, 6)}`,
      mcpAuthKind: "none",
    });
    expect((await validate(dataset(providerKey))).errors).toEqual([]);
  });

  test("a disabled connection still proves the app EXISTS", async () => {
    // Refusing here would block a page written while its connection is being
    // repaired — the check is "is this an app", not "is it usable right now".
    // The two queries in this module differ on exactly this point, and only a
    // real row can show that the difference is deliberate rather than a typo.
    const { providerKey } = await fx.createConnection({ status: "disabled" });
    expect((await validate(dataset(providerKey))).errors).toEqual([]);
    expect(await teamConnectedProviderKeys(fx.teamId)).not.toContain(
      providerKey,
    );
  });
});

describe("an app this workspace does not have is refused", () => {
  test("the error names the key, the catalogue, and the module/key trap", async () => {
    const { providerKey } = await fx.createConnection();
    const { errors } = await validate(dataset("acme-post"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dataset "stock"');
    expect(errors[0]).toContain("acme-post");
    expect(errors[0]).toContain(providerKey);
    expect(errors[0]).toContain("NOT the providerKey");
  });

  test("an app operation is held to the same rule", async () => {
    await fx.createConnection();
    const { errors } = await validate(
      definition({
        operations: [
          {
            kind: "app",
            id: "send",
            providerKey: "acme-post",
            action: "send_message",
          },
        ],
      }),
    );
    expect(errors[0]).toContain('operation "send"');
  });

  test("another team's connection is not this team's catalogue", async () => {
    // The claim the old fake could not make: its `findMany` returned the
    // fixture list whatever the `where` said, so deleting `teamId` from the
    // query changed nothing. Deleting it here turns this test red — and in
    // production it would let one workspace's page validate against another
    // workspace's connected apps.
    const other = await createWorkspaceFixture();
    try {
      const { providerKey } = await other.createConnection();
      await fx.createConnection();
      const { errors } = await validate(dataset(providerKey));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(providerKey);
      expect(await teamConnectedProviderKeys(fx.teamId)).not.toContain(
        providerKey,
      );
    } finally {
      await other.cleanup();
    }
  });
});

describe("what it deliberately does not judge", () => {
  test("a pinned connectionId is resolved by id — its providerKey is decoration", async () => {
    await fx.createConnection();
    const pinned = dataset(
      "whatever-this-says",
      "00000000-0000-4000-8000-000000000001",
    );
    expect((await validate(pinned)).errors).toEqual([]);
  });

  test("no registry AND no connections cannot tell a typo from an unloaded app", async () => {
    // A 400 here would turn an environment gap into a user-facing refusal.
    const empty = await createWorkspaceFixture();
    try {
      const { errors } = await validate(dataset("acme-post"), empty.teamId);
      expect(errors).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  test("a page that names no provider asks the database nothing", async () => {
    // Proved through the public surface, with a team id Postgres cannot parse:
    // any query on it raises `invalid input syntax for type uuid`, so a clean
    // `[]` is the query not happening. The old fake counted `where` clauses,
    // which proved only that the fake had not been called.
    expect((await validate(definition({}), "not-a-uuid")).errors).toEqual([]);
    // …and the same call WITH a provider does reach Postgres, so the line
    // above is the early return and not a query that silently answers nothing.
    const err = await rejection(validate(dataset("acme-post"), "not-a-uuid"));
    expect(err.message).toContain("uuid");
  });
});

describe("teamConnectedProviderKeys", () => {
  test("only active connections count — a broken one is not a connected team", async () => {
    const scoped = await createWorkspaceFixture();
    try {
      const active = await scoped.createConnection({ status: "active" });
      const broken = await scoped.createConnection({ status: "error" });
      const keys = await teamConnectedProviderKeys(scoped.teamId);
      expect([...keys]).toEqual([active.providerKey]);
      expect(keys.has(broken.providerKey)).toBe(false);
    } finally {
      await scoped.cleanup();
    }
  });

  test("a user-scoped connection still counts for the team", async () => {
    // `userId` set means "only this member connected it", and the function's
    // docstring says the team is connected all the same — that is the whole
    // distinction it exists to draw. Never verified before: the fake had no
    // `userId` column.
    const scoped = await createWorkspaceFixture();
    try {
      const owned = await scoped.createConnection({
        userId: scoped.userIds[1],
      });
      const keys = await teamConnectedProviderKeys(scoped.teamId);
      expect(keys.has(owned.providerKey)).toBe(true);
      const rows = await db.query.externalAppConnections.findMany({
        columns: { userId: true },
        where: { teamId: scoped.teamId },
      });
      expect(rows.map((r) => r.userId)).toEqual([scoped.userIds[1]]);
    } finally {
      await scoped.cleanup();
    }
  });
});
