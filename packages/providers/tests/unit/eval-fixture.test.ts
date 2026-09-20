import { describe, expect, test } from "bun:test";
import { CUSTOMERS, INVOICES, ORDERS } from "../../src/eval-fixture/data";
import { evalFixtureHandlers } from "../../src/eval-fixture/handlers";
import { evalFixtureManifest } from "../../src/eval-fixture/manifest";

/**
 * The fixture provider the sync eval suite reads.
 *
 * These tests exist because a test double that lies is worse than no double at
 * all: the suite would go green against behaviour the real walker never sees.
 * Two properties are load-bearing and neither is obvious from the manifest —
 * it really paginates, and it really honours `updated_after`.
 */

const ctx = { credentials: {}, connection_config: {} };

/**
 * Call by ACTION name, resolving the handler the way the dispatcher does.
 *
 * Going through the manifest rather than straight to `evalFixtureHandlers`
 * means every case below also proves the action→handler binding, which is the
 * one thing a rename can break silently in either file.
 */
const call = async (
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const declared = evalFixtureManifest.actions.find((a) => a.name === action);
  if (declared?.handler === undefined) {
    throw new Error(`no action "${action}" declaring a handler`);
  }
  const handler = evalFixtureHandlers[declared.handler];
  if (handler === undefined) {
    throw new Error(`no handler "${declared.handler}"`);
  }
  return await handler(args, ctx);
};

describe("it answers, and it answers from memory", () => {
  test("every declared handler exists", () => {
    // The registry checks this at boot too; here it fails in a second rather
    // than in whatever imports the package next.
    for (const action of evalFixtureManifest.actions) {
      expect(action.handler).toBeDefined();
      expect(evalFixtureHandlers[action.handler ?? ""]).toBeDefined();
    }
  });

  test("it is marked as a test double and cannot be connected", () => {
    // `testOnly` is what keeps it out of the connect catalogue AND out of the
    // credential fetch. Losing it would put a fake app in front of users.
    expect(evalFixtureManifest.testOnly).toBe(true);
    expect(evalFixtureManifest.transport.kind).toBe("custom-handler");
  });

  test("it is the ONLY provider carrying the flag", async () => {
    // The catalogue endpoint hides `testOnly` providers, so the flag is the
    // single thing standing between a real app and disappearing from the
    // connect list. A guard here is cheaper than a support ticket.
    await import("../../src/index");
    const { listProviderManifests } =
      await import("@fretik/shared/external-apps/registry");
    const flagged = listProviderManifests()
      .filter((m) => m.testOnly === true)
      .map((m) => m.key);
    expect(flagged).toEqual(["eval-fixture"]);
  });

  test("nothing here writes", () => {
    // A double that could change state is a double that needs cleaning up
    // between cases, and the suite has enough of that already.
    expect(evalFixtureManifest.actions.every((a) => a.kind === "read")).toBe(
      true,
    );
  });
});

describe("pagination is real, not decoration", () => {
  test("`limit` bounds the page and `offset` moves it", async () => {
    // The walker's page loop, its checkpoints and its call budget are the code
    // this fixture exists to exercise. A handler that ignored `limit` would let
    // all three pass while never being used.
    const first = await call("list_orders", { limit: 2, offset: 0 });
    const second = await call("list_orders", { limit: 2, offset: 2 });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(ORDERS.length - 2);
    expect((first as { id: string }[])[0]?.id).toBe(ORDERS[0]?.id);
    expect((second as { id: string }[])[0]?.id).toBe(ORDERS[2]?.id);
  });

  test("past the end is an empty page, never a wrap-around", async () => {
    expect(await call("list_orders", { offset: 999 })).toHaveLength(0);
  });

  test("the three lists all page", async () => {
    expect(await call("list_invoices", { limit: 1 })).toHaveLength(1);
    expect(await call("list_customers", { limit: 1 })).toHaveLength(1);
    expect(await call("list_customers", {})).toHaveLength(CUSTOMERS.length);
  });
});

describe("the incremental bound is applied", () => {
  test("a future lower bound returns nothing", async () => {
    // A fixture that accepted `updated_after` and returned everything anyway
    // would hide the exact defect `assert-since-binding.ts` exists to catch: a
    // `{$since}` bound to a parameter the app silently drops.
    expect(
      await call("list_orders", { updated_after: "2030-01-01T00:00:00Z" }),
    ).toHaveLength(0);
  });

  test("a past lower bound returns everything", async () => {
    expect(
      await call("list_orders", { updated_after: "2000-01-01T00:00:00Z" }),
    ).toHaveLength(ORDERS.length);
  });

  test("an unparseable bound is ignored rather than emptying the answer", async () => {
    expect(
      await call("list_orders", { updated_after: "not a date" }),
    ).toHaveLength(ORDERS.length);
  });
});

describe("the rows line up with what the eval suite seeds", () => {
  test("an invoice keys on an order's reference", () => {
    // This chain is what `obj-sync-second-app` measures: the second app matches
    // on a value the FIRST one wrote into the collection.
    const references = new Set(ORDERS.map((order) => order.reference));
    for (const invoice of INVOICES) {
      expect(references.has(invoice.order_reference)).toBe(true);
    }
  });

  test("one customer matches no record, on purpose", () => {
    // A walk has to report it `unmatched` rather than inventing a record, and a
    // fixture where everything matches cannot show the difference.
    const codes = CUSTOMERS.map((customer) => customer.code);
    expect(codes).toContain("CL-999");
    expect(ORDERS.every((order) => order.client_code !== "CL-999")).toBe(true);
  });

  test("timestamps are fixed, never `now`", () => {
    // Three sync cases turn on how old the data is. A self-stamping fixture
    // would make that age depend on when the suite happened to run.
    expect(new Set(ORDERS.map((o) => o.updated_at)).size).toBe(1);
    expect(ORDERS[0]?.updated_at).toBe("2026-09-19T09:14:19.000Z");
  });
});

describe("a single-record read", () => {
  test("resolves by id", async () => {
    expect(await call("get_order", { id: "ord_1001" })).toMatchObject({
      reference: "EV-1001",
    });
    expect(await call("get_customer", { id: "cus_001" })).toMatchObject({
      code: "CL-001",
    });
  });

  test("throws on an unknown id rather than answering null", async () => {
    // A caller that got `null` would read a missing row as an empty one.
    expect(call("get_order", { id: "nope" })).rejects.toThrow("no order");
  });
});
