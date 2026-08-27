import { beforeEach, describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()`; in a service that happens at boot.
import "@hono/zod-openapi";
import type { PageDefinition, PageValue } from "../../src/schemas/pages";
import { mockModule } from "./mock-module";

/**
 * The WRITE path's refusals — the half of a page that reaches a third party.
 *
 * This path deliberately has no approval card (a page has no conversation, and
 * the person clicking IS the approver), so what stands in its place is checked
 * here: the operation must be declared, the action must not be blocked, a
 * destructive action must have been given a confirmation step, and — the one
 * that matters most — a value the argument template does not reference must
 * never reach the app.
 */

interface Connection {
  id: string;
  providerKey: string;
  displayName: string;
  teamId: string;
  userId: string | null;
  status: string;
  actionPolicies: Record<string, string> | null;
  mcpAuthKind: string | null;
}

let definition: PageDefinition;
let connection: Connection | undefined;
let destructive = false;
/** Args the app was actually called with — null when it was never called. */
let calledWith: Record<string, PageValue> | null = null;

const baseConnection: Connection = {
  id: "conn-1",
  providerKey: "acme-orders",
  displayName: "Acme Orders",
  teamId: "team-1",
  userId: null,
  status: "active",
  actionPolicies: null,
  mcpAuthKind: "none",
};

await mockModule("../../src/db", {
  default: {
    query: {
      externalAppConnections: {
        findFirst: () => Promise.resolve(connection),
        findMany: () => Promise.resolve(connection ? [connection] : []),
      },
      // No viewer has chosen an account here — the automatic pick applies.
      externalAppConnectionPreferences: { findMany: () => Promise.resolve([]) },
    },
  },
});

await mockModule("../../src/services/pages/retrieve", {
  getPage: () => Promise.resolve({ id: "page-1", definition }),
});

await mockModule("../../src/services/external-apps/mcp/snapshot-store", {
  getSnapshotForConnection: () =>
    Promise.resolve({
      descriptor: {
        actions: [
          {
            name: "create_order",
            kind: "write",
            approvalDefault: "approval",
            mcpToolName: "create-order",
            annotations: { destructiveHint: destructive },
          },
          {
            name: "list_orders",
            kind: "read",
            approvalDefault: "auto",
            mcpToolName: "list-orders",
          },
        ],
      },
    }),
});

await mockModule("../../src/services/external-apps/mcp/transport", {
  mcpCallTool: (
    _connection: unknown,
    _name: string,
    args: Record<string, PageValue>,
  ) => {
    calledWith = args;
    return Promise.resolve({
      content: [{ type: "text", text: '{"id":"o-1"}' }],
    });
  },
});

const { runPageOperation } =
  await import("../../src/services/pages/run-operation");

const pageWith = (
  operations: PageDefinition["operations"],
  variables: PageDefinition["variables"] = [],
): PageDefinition => ({
  version: 3,
  variables,
  datasets: [],
  operations,
  code: { source: "<template><div>x</div></template>" },
});

const run = (variables: Record<string, PageValue> = {}) =>
  runPageOperation({
    pageId: "page-1",
    organizationId: "org-1",
    teamId: "team-1",
    userId: "user-1",
    operation: "create",
    variables,
  });

beforeEach(() => {
  connection = { ...baseConnection };
  destructive = false;
  calledWith = null;
  definition = pageWith([
    {
      kind: "app",
      id: "create",
      providerKey: "acme-orders",
      action: "create_order",
      args: { reference: { var: "reference" } },
    },
  ]);
});

describe("what a page may run", () => {
  test("an operation the definition does not declare is refused", async () => {
    definition = pageWith([]);
    const result = await run();
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("declares no operation");
    }
    expect(calledWith).toBeNull();
  });

  test("a blocked action is refused with its own verdict", async () => {
    connection = {
      ...baseConnection,
      actionPolicies: { create_order: "blocked" },
    };
    const result = await run();
    expect(result.status).toBe("blocked");
    expect(calledWith).toBeNull();
  });

  test("an `approval` policy still runs — the person clicking is the approver", async () => {
    // The default for a write is `approval`, which gates an AGENT mid-turn.
    // A page write is a human act with a confirmation in front of it, so the
    // level that must refuse is `blocked`, and only that one.
    const result = await run({ reference: "PO-1" });
    expect(result.status).toBe("ok");
  });

  test("a destructive action without a declared confirm is refused SERVER-side", async () => {
    destructive = true;
    const result = await run({ reference: "PO-1" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("destructive");
    }
    expect(calledWith).toBeNull();
  });

  test("the same destructive action runs once the page declares a confirm", async () => {
    destructive = true;
    definition = pageWith([
      {
        kind: "app",
        id: "create",
        providerKey: "acme-orders",
        action: "create_order",
        args: {},
        confirm: { title: "Create this order?" },
      },
    ]);
    const result = await run();
    expect(result.status).toBe("ok");
  });

  test("no connection for this viewer is a prompt, not a failure", async () => {
    connection = undefined;
    const result = await run();
    expect(result).toEqual({
      status: "needs_connection",
      providerKey: "acme-orders",
    });
    expect(calledWith).toBeNull();
  });
});

describe("the argument boundary", () => {
  test("only what the stored template references reaches the app", async () => {
    definition = pageWith(
      [
        {
          kind: "app",
          id: "create",
          providerKey: "acme-orders",
          action: "create_order",
          args: { reference: { var: "reference" } },
        },
      ],
      [{ key: "reference", type: "string" }],
    );

    const result = await run({
      reference: "PO-42",
      // Neither is declared by the page: one is an undeclared variable, the
      // other is the shape a forged request would take to smuggle a field.
      secret: "should-not-travel",
      customer_id: "victim",
    });

    expect(result.status).toBe("ok");
    expect(calledWith).toEqual({ reference: "PO-42" });
  });

  test("a declared variable is coerced to its type before it is sent", async () => {
    definition = pageWith(
      [
        {
          kind: "app",
          id: "create",
          providerKey: "acme-orders",
          action: "create_order",
          args: { quantity: { var: "quantity" } },
        },
      ],
      [{ key: "quantity", type: "number", initial: 1 }],
    );

    // A string where a number is declared does not pass — it falls back to the
    // declared initial rather than reaching the app as the wrong type.
    const result = await run({ quantity: "not-a-number" });
    expect(result.status).toBe("ok");
    expect(calledWith).toEqual({ quantity: 1 });
  });

  test("a binding that resolves to nothing drops its argument instead of sending null", async () => {
    definition = pageWith(
      [
        {
          kind: "app",
          id: "create",
          providerKey: "acme-orders",
          action: "create_order",
          args: {
            reference: { var: "reference" },
            note: { var: "missing" },
          },
        },
      ],
      [{ key: "reference", type: "string" }],
    );
    const result = await run({ reference: "PO-7" });
    expect(result.status).toBe("ok");
    expect(calledWith).toEqual({ reference: "PO-7" });
  });
});
