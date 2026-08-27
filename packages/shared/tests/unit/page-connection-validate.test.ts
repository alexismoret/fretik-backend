import "@hono/zod-openapi";
import { beforeEach, describe, expect, test } from "bun:test";
import type { PageDefinition } from "../../src/schemas/pages";
import { mockModule } from "./mock-module";

/**
 * `validatePageDefinitionConnections` — the one data-half check that REFUSES.
 *
 * It exists because the failure it catches is silent: a dataset over a provider
 * key nothing can match does not error at view time, it answers
 * `needs_connection`, which reads to everyone as "you are not connected". The
 * page then ships and can never load. Measured on a real Akanea WMS page,
 * 2026-08-26.
 *
 * No provider is registered in a bare test, so `listProviderKeys()` is empty
 * here — which is exactly the arrangement that exercises the OTHER half of the
 * known set, the team's own connections. That union is what keeps a page over a
 * custom MCP server (whose key is minted at connect time and is in no registry)
 * from being refused.
 */

let connections: { providerKey: string; status: string }[] = [];
const wheres: Record<string, unknown>[] = [];

await mockModule("../../src/db", {
  default: {
    query: {
      externalAppConnections: {
        findMany: (args: { where?: Record<string, unknown> }) => {
          wheres.push(args.where ?? {});
          const status = args.where?.["status"];
          return Promise.resolve(
            status === undefined
              ? connections
              : connections.filter((row) => row.status === status),
          );
        },
      },
    },
  },
});

const { teamConnectedProviderKeys, validatePageDefinitionConnections } =
  await import("../../src/services/pages/validate-connections");

const definition = (extra: Partial<PageDefinition>): PageDefinition => ({
  version: 3,
  variables: [],
  datasets: [],
  operations: [],
  code: { source: "<template><div>x</div></template>" },
  ...extra,
});

const dataset = (providerKey?: string, connectionId?: string) =>
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

const validate = (input: PageDefinition) =>
  validatePageDefinitionConnections({ definition: input, teamId: "team-1" });

beforeEach(() => {
  connections = [];
  wheres.length = 0;
});

describe("what the team has is part of the catalogue", () => {
  test("a key the team is connected to passes, registry or not", async () => {
    connections = [{ providerKey: "acme-mail", status: "active" }];
    expect((await validate(dataset("acme-mail"))).errors).toEqual([]);
  });

  test("an MCP slug the team connected passes — no registry could know it", async () => {
    connections = [{ providerKey: "notion-mcp-7f3a", status: "active" }];
    expect((await validate(dataset("notion-mcp-7f3a"))).errors).toEqual([]);
  });

  test("a disabled connection still proves the app EXISTS", async () => {
    // Refusing here would block a page written while its connection is being
    // repaired — the check is "is this an app", not "is it usable right now".
    connections = [{ providerKey: "acme-mail", status: "disabled" }];
    expect((await validate(dataset("acme-mail"))).errors).toEqual([]);
  });
});

describe("an app this workspace does not have is refused", () => {
  test("the error names the key, the catalogue, and the module/key trap", async () => {
    connections = [{ providerKey: "acme-mail", status: "active" }];
    const { errors } = await validate(dataset("acme-post"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('dataset "stock"');
    expect(errors[0]).toContain("acme-post");
    expect(errors[0]).toContain("acme-mail");
    expect(errors[0]).toContain("NOT the providerKey");
  });

  test("an app operation is held to the same rule", async () => {
    connections = [{ providerKey: "acme-mail", status: "active" }];
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
});

describe("what it deliberately does not judge", () => {
  test("a pinned connectionId is resolved by id — its providerKey is decoration", async () => {
    connections = [{ providerKey: "acme-mail", status: "active" }];
    const pinned = dataset(
      "whatever-this-says",
      "00000000-0000-4000-8000-000000000001",
    );
    expect((await validate(pinned)).errors).toEqual([]);
  });

  test("no registry AND no connections cannot tell a typo from an unloaded app", async () => {
    // A 400 here would turn an environment gap into a user-facing refusal.
    connections = [];
    expect((await validate(dataset("acme-post"))).errors).toEqual([]);
  });

  test("a page that names no provider asks the database nothing", async () => {
    expect((await validate(definition({}))).errors).toEqual([]);
    expect(wheres).toHaveLength(0);
  });
});

describe("teamConnectedProviderKeys", () => {
  test("only active connections count — a broken one is not a connected team", async () => {
    connections = [
      { providerKey: "acme-mail", status: "active" },
      { providerKey: "acme-post", status: "error" },
    ];
    const keys = await teamConnectedProviderKeys("team-1");
    expect([...keys]).toEqual(["acme-mail"]);
  });
});
