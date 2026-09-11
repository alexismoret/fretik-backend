import "@hono/zod-openapi";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";
import db from "../../../src/db";
import { externalAppConnections, pages } from "../../../src/db/schema";
import type { PageDefinition, PageValue } from "../../../src/schemas/pages";
import {
  createWorkspaceFixture,
  type WorkspaceFixture,
} from "../../lib/db-fixtures";
import { mockModule } from "../../lib/mock-module";

/**
 * The WRITE path's refusals — the half of a page that reaches a third party.
 *
 * This path deliberately has no approval card (a page has no conversation, and
 * the person clicking IS the approver), so what stands in its place is checked
 * here: the operation must be declared, the action must not be blocked, a
 * destructive action must have been given a confirmation step, and — the one
 * that matters most — a value the argument template does not reference must
 * never reach the app.
 *
 * Until 2026-09-02 this ran against a fake whose `externalAppConnections.findFirst`
 * answered with the same connection whatever it was asked, and whose viewer
 * preference table always answered `[]`. Both are now real rows, so "no
 * connection for this viewer" is a query that found nothing rather than a
 * variable set to `undefined`.
 *
 * The MCP snapshot and transport stay doubled: the descriptor is what a remote
 * server advertises and the call is a socket. `mcpCallTool` is also the only
 * place the arguments can be OBSERVED, which is what the argument-boundary
 * block asserts on.
 */

let destructive = false;
/** Args the app was actually called with — null when it was never called. */
let calledWith: Record<string, PageValue> | null = null;

/** The provider these doubles speak for. Declared above them: what makes them
 *  safe is that they answer for THIS app and nothing else. */
const PROVIDER = "acme-orders";

/**
 * Both doubles below are scoped to `PROVIDER`, and that is load-bearing rather
 * than tidy.
 *
 * `mock.module` registers process-wide. `--isolate` gives each test file its
 * own module registry for its imports, but it does NOT contain these
 * registrations: on 2026-09-11 a full integration run had
 * `update-action-policies.test.ts` receive THIS file's snapshot double —
 * `create_order` / `list_orders` in place of its own tool list — and fail its
 * three MCP tests with `Unknown action "items"`. It depended on file order, so
 * it reproduced only at some `--seed` values and passed when that file ran
 * alone: a suite that goes red on an unrelated PR every few runs.
 *
 * A global double is a claim about every connection in the process. These make
 * the narrower, true claim — "the server behind `acme-orders` advertises these
 * two tools" — and hand anything else back to the real implementation.
 */
// The FUNCTION, captured before the swap — not the namespace object it came
// from. A module namespace is a live view: read after `mock.module`, it hands
// back the override, and delegating to it is a call into itself that never
// returns. (The suite hung, it did not fail.) `mockModule`'s own `{...actual}`
// works for the same reason — it copies values at registration time.
const realGetSnapshotForConnection = (
  await import("../../../src/services/external-apps/mcp/snapshot-store")
).getSnapshotForConnection;
type SnapshotSubject = Parameters<typeof realGetSnapshotForConnection>[0];

await mockModule("../../src/services/external-apps/mcp/snapshot-store", {
  getSnapshotForConnection: (connection: SnapshotSubject) =>
    connection.providerKey === PROVIDER
      ? Promise.resolve({
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
        })
      : realGetSnapshotForConnection(connection),
});

await mockModule("../../src/services/external-apps/mcp/transport", {
  mcpCallTool: (
    connection: { providerKey?: string },
    _name: string,
    args: Record<string, PageValue>,
  ) => {
    // The real one opens a socket, so this never delegates — it refuses
    // loudly instead. A leaked `{"id":"o-1"}` would be a foreign suite
    // silently passing on an answer it never made.
    if (connection.providerKey !== PROVIDER) {
      throw new Error(
        `mcpCallTool double belongs to run-operation.test.ts (${PROVIDER}); it was reached for "${connection.providerKey ?? "unknown"}". mock.module is process-wide — scope the double by provider.`,
      );
    }
    calledWith = args;
    return Promise.resolve({
      content: [{ type: "text", text: '{"id":"o-1"}' }],
    });
  },
});

const { runPageOperation } =
  await import("../../../src/services/pages/run-operation");

let fx: WorkspaceFixture;
let otherFx: WorkspaceFixture;
let pageId: string;

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

const defaultDefinition = (): PageDefinition =>
  pageWith([
    {
      kind: "app",
      id: "create",
      providerKey: PROVIDER,
      action: "create_order",
      args: { reference: { var: "reference" } },
    },
  ]);

/** Rewrite the page's stored definition — the operation catalogue is the page. */
const setDefinition = async (definition: PageDefinition): Promise<void> => {
  await db.update(pages).set({ definition }).where(eq(pages.id, pageId));
};

beforeAll(async () => {
  fx = await createWorkspaceFixture();
  otherFx = await createWorkspaceFixture();
  pageId = (await fx.createPage({ definition: defaultDefinition() })).id;
});

afterAll(async () => {
  await fx.cleanup();
  await otherFx.cleanup();
});

beforeEach(async () => {
  destructive = false;
  calledWith = null;
  await setDefinition(defaultDefinition());
});

/**
 * Connections do not survive their test.
 *
 * `randomize` is on, so "nothing is connected for this provider" can only be
 * stated by a suite where a connection left behind by a neighbour cannot
 * exist. The workspace fixture's own cleanup runs once, at the end, which is
 * far too late for that.
 */
afterEach(async () => {
  await db
    .delete(externalAppConnections)
    .where(
      inArray(externalAppConnections.organizationId, [
        fx.organizationId,
        otherFx.organizationId,
      ]),
    );
});

const run = (variables: Record<string, PageValue> = {}) =>
  runPageOperation({
    pageId,
    organizationId: fx.organizationId,
    teamId: fx.teamId,
    userId: fx.userIds[0],
    operation: "create",
    variables,
  });

/** A live team-scoped connection for this provider, dropped by the caller. */
const connect = async (
  overrides: Parameters<WorkspaceFixture["createConnection"]>[0] = {},
) =>
  fx.createConnection({
    providerKey: PROVIDER,
    // A snapshot is only looked up when the connection claims one; the
    // fingerprint's VALUE is the double's business, its presence is not.
    toolFingerprint: "f".repeat(64),
    mcpAuthKind: "none",
    ...overrides,
  });

describe("what a page may run", () => {
  test("an operation the definition does not declare is refused", async () => {
    await connect();
    await setDefinition(pageWith([]));

    const result = await run();

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("declares no operation");
    }
    expect(calledWith).toBeNull();
  });

  test("a blocked action is refused with its own verdict", async () => {
    await connect({ actionPolicies: { create_order: "blocked" } });

    const result = await run();

    expect(result.status).toBe("blocked");
    expect(calledWith).toBeNull();
  });

  test("an `approval` policy still runs — the person clicking is the approver", async () => {
    // The default for a write is `approval`, which gates an AGENT mid-turn.
    // A page write is a human act with a confirmation in front of it, so the
    // level that must refuse is `blocked`, and only that one.
    await connect();

    expect((await run({ reference: "PO-1" })).status).toBe("ok");
  });

  test("a destructive action without a declared confirm is refused SERVER-side", async () => {
    await connect();
    destructive = true;

    const result = await run({ reference: "PO-1" });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("destructive");
    }
    expect(calledWith).toBeNull();
  });

  test("the same destructive action runs once the page declares a confirm", async () => {
    await connect();
    destructive = true;
    await setDefinition(
      pageWith([
        {
          kind: "app",
          id: "create",
          providerKey: PROVIDER,
          action: "create_order",
          args: {},
          confirm: { title: "Create this order?" },
        },
      ]),
    );

    expect((await run()).status).toBe("ok");
  });

  test("no connection for this provider is a prompt, not a failure", async () => {
    // Nothing connected in this workspace at all.
    expect(await run()).toEqual({
      status: "needs_connection",
      providerKey: PROVIDER,
    });
    expect(calledWith).toBeNull();
  });

  test("another workspace's connection is not this page's", async () => {
    // The old fake returned its one connection to every query, so no test in
    // this file could tell a scoped lookup from an unscoped one — and what
    // that lookup decides is whose credentials a click spends.
    await otherFx.createConnection({
      providerKey: PROVIDER,
      toolFingerprint: "f".repeat(64),
      mcpAuthKind: "none",
    });

    expect(await run()).toEqual({
      status: "needs_connection",
      providerKey: PROVIDER,
    });
    expect(calledWith).toBeNull();
  });

  test("a colleague's PRIVATE connection is not this viewer's", async () => {
    await connect({ userId: fx.userIds[1] });

    expect(await run()).toEqual({
      status: "needs_connection",
      providerKey: PROVIDER,
    });
    expect(calledWith).toBeNull();
  });

  test("a connection that is not active does not serve the page", async () => {
    await connect({ status: "disabled" });

    expect(await run()).toEqual({
      status: "needs_connection",
      providerKey: PROVIDER,
    });
    expect(calledWith).toBeNull();
  });
});

describe("the argument boundary", () => {
  beforeEach(async () => {
    await connect();
  });

  test("only what the stored template references reaches the app", async () => {
    await setDefinition(
      pageWith(
        [
          {
            kind: "app",
            id: "create",
            providerKey: PROVIDER,
            action: "create_order",
            args: { reference: { var: "reference" } },
          },
        ],
        [{ key: "reference", type: "string" }],
      ),
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
    await setDefinition(
      pageWith(
        [
          {
            kind: "app",
            id: "create",
            providerKey: PROVIDER,
            action: "create_order",
            args: { quantity: { var: "quantity" } },
          },
        ],
        [{ key: "quantity", type: "number", initial: 1 }],
      ),
    );

    // A string where a number is declared does not pass — it falls back to the
    // declared initial rather than reaching the app as the wrong type.
    const result = await run({ quantity: "not-a-number" });

    expect(result.status).toBe("ok");
    expect(calledWith).toEqual({ quantity: 1 });
  });

  test("a binding that resolves to nothing drops its argument instead of sending null", async () => {
    await setDefinition(
      pageWith(
        [
          {
            kind: "app",
            id: "create",
            providerKey: PROVIDER,
            action: "create_order",
            args: {
              reference: { var: "reference" },
              note: { var: "missing" },
            },
          },
        ],
        [{ key: "reference", type: "string" }],
      ),
    );

    const result = await run({ reference: "PO-7" });

    expect(result.status).toBe("ok");
    expect(calledWith).toEqual({ reference: "PO-7" });
  });
});
