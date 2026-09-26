import { beforeEach, describe, expect, test } from "bun:test";
import type { ExecContext } from "../../src/services/sandbox/types";
import { mockModule } from "../lib/mock-module";

/**
 * A sub-agent's Python cell may read the team's data and apps; it may never
 * write to them or open an approval.
 *
 * Its tool set carries no write tool, but its `python` reaches the objects
 * SDK and the connected apps through `/sandbox/exec` — the one door a tool
 * list cannot close. The request cannot say whose cell sent it (the sandbox
 * holds one credential per turn), so the caller marks the conversation for
 * the length of the cell, inside the exec mutex, and the dispatcher reads the
 * mark. Before this, an approval a sub-agent opened had no card to answer it
 * and blocked every later approval in the conversation.
 *
 * Doubled at the process boundary (Redis) and at the three dispatchers, which
 * are asserted on as routes: what reaches them, and with which scope.
 */

const store = new Map<string, string>();
await mockModule("../../src/lib/redis", {
  redis: {
    set: async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    },
    get: async (key: string) => store.get(key) ?? null,
    del: async (key: string) => (store.delete(key) ? 1 : 0),
  },
});

const routed: { to: string; op?: string; readOnly?: boolean }[] = [];
await mockModule("../../src/services/sandbox/collections", {
  dispatchCollections: async (_ctx: ExecContext, op: string) => {
    routed.push({ to: "collections", op });
    return { status: "ok", data: null };
  },
});
await mockModule("../../src/services/external-apps/exec/plan", {
  dispatchPlan: async () => {
    routed.push({ to: "plan" });
    return { status: "ok", data: null };
  },
});
await mockModule("../../src/services/external-apps/exec/read", {
  dispatchRead: async (ctx: ExecContext) => {
    routed.push({ to: "read", readOnly: ctx.readOnly });
    return { status: "ok", data: null };
  },
});

const { dispatchSandboxExec } =
  await import("../../src/services/sandbox/dispatch");
const { withSubAgentExecScope, isSubAgentExecScope } =
  await import("../../src/services/sandbox/exec-scope");
const { approvalRefusedInSubAgent } =
  await import("../../src/services/external-apps/exec/sub-agent-refusal");

const ctx: ExecContext = {
  organizationId: "org-1",
  teamId: "team-1",
  userId: "user-1",
  conversationId: "conv-1",
  turnId: "turn-1",
};

/** Run one sandbox call as the parent, or from inside a sub-agent's cell. */
const exec = (
  request: Parameters<typeof dispatchSandboxExec>[1],
  asSubAgent: boolean,
) =>
  asSubAgent
    ? withSubAgentExecScope(ctx.conversationId, () =>
        dispatchSandboxExec(ctx, request),
      )
    : dispatchSandboxExec(ctx, request);

beforeEach(() => {
  store.clear();
  routed.length = 0;
});

describe("sandbox calls from a sub-agent's cell", () => {
  test("the parent keeps every door", async () => {
    await exec({ kind: "plan", operations: [] }, false);
    await exec(
      { kind: "collections", op: "records.bulk_update", args: {} },
      false,
    );
    await exec({ kind: "read", action: "crm.list_deals", args: {} }, false);
    expect(routed).toEqual([
      { to: "plan" },
      { to: "collections", op: "records.bulk_update" },
      { to: "read", readOnly: false },
    ]);
  });

  test("a write plan to a connected app is refused", async () => {
    const result = await exec({ kind: "plan", operations: [] }, true);
    expect(result.status).toBe("error");
    expect(Reflect.get(result, "message")).toStartWith("READ_ONLY_SUB_AGENT:");
    expect(routed).toEqual([]);
  });

  test("record and schema writes are refused, queries go through", async () => {
    for (const op of [
      "records.bulk_create",
      "records.bulk_update",
      "records.bulk_delete",
      "records.import_begin",
      "schema.add_field",
      "sync.create",
      // A refresh pulls rows INTO a collection: a write, for this purpose.
      "sync.refresh",
    ]) {
      const result = await exec({ kind: "collections", op, args: {} }, true);
      expect(`${op}:${result.status}`).toBe(`${op}:error`);
    }
    for (const op of ["records.query", "sync.list", "sync.preview"]) {
      const result = await exec({ kind: "collections", op, args: {} }, true);
      expect(`${op}:${result.status}`).toBe(`${op}:ok`);
    }
    expect(routed.map((entry) => entry.op)).toEqual([
      "records.query",
      "sync.list",
      "sync.preview",
    ]);
  });

  test("a read goes through, flagged so it cannot open an approval", async () => {
    await exec({ kind: "read", action: "crm.list_deals", args: {} }, true);
    expect(routed).toEqual([{ to: "read", readOnly: true }]);
    expect(approvalRefusedInSubAgent("crm.list_deals")).toEqual({
      status: "error",
      message: expect.stringMatching(/^APPROVAL_NEEDED: /),
    });
  });

  test("the mark lasts exactly as long as the cell", async () => {
    expect(await isSubAgentExecScope(ctx.conversationId)).toBe(false);
    await withSubAgentExecScope(ctx.conversationId, async () => {
      expect(await isSubAgentExecScope(ctx.conversationId)).toBe(true);
    });
    expect(await isSubAgentExecScope(ctx.conversationId)).toBe(false);
    // A cell that throws must not leave the parent locked out of its writes.
    await withSubAgentExecScope(ctx.conversationId, async () => {
      throw new Error("cell failed");
    }).catch(() => undefined);
    expect(await isSubAgentExecScope(ctx.conversationId)).toBe(false);
  });
});
