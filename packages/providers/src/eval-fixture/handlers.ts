import type { ProviderHandlers } from "@fretik/shared/external-apps/provider-types";
import { CUSTOMERS, INVOICES, ORDERS } from "./data";

/**
 * Handlers for the eval fixture provider.
 *
 * They read from memory and touch nothing else — no network, no database, no
 * clock. That is what lets the sync eval suite run the REAL walker, governor
 * and diff against an app that actually answers, and still be hermetic.
 *
 * They also honour pagination for real rather than returning everything once.
 * The walker's page loop, its checkpoints and its call budget are the code
 * these fixtures exist to exercise, and a handler that ignores `limit` would
 * let all three pass while never being used.
 */

const asInt = (value: unknown, fallback: number): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

/**
 * `limit`/`offset` over a fixed list — the `offset` pagination the manifest
 * declares. Returns the ARRAY, because the actions declare `returns: {list}`
 * and the walker reads the answer itself rather than a `resultPath` into it.
 */
const page = <T>(rows: readonly T[], args: Record<string, unknown>): T[] => {
  const limit = Math.max(1, Math.min(100, asInt(args.limit, 50)));
  const offset = Math.max(0, asInt(args.offset, 0));
  return rows.slice(offset, offset + limit);
};

/**
 * `updated_after` is applied, not ignored.
 *
 * The incremental path is a declared capability (`incremental` on the action),
 * and a source that binds `{"$since": true}` to a parameter the app silently
 * drops is the exact defect `assert-since-binding.ts` exists to catch. A
 * fixture that accepted the argument and returned everything would make that
 * bug invisible here.
 */
const keptSince = (updatedAt: string, since: string): boolean => {
  const bound = Date.parse(since);
  return Number.isNaN(bound) || Date.parse(updatedAt) >= bound;
};

export const evalFixtureHandlers: ProviderHandlers = {
  listOrders: (args) => {
    const since = args.updated_after;
    const filtered =
      typeof since === "string" && since !== ""
        ? ORDERS.filter((order) => keptSince(order.updated_at, since))
        : ORDERS;
    return Promise.resolve(page(filtered, args));
  },
  getOrder: (args) => {
    const found = ORDERS.find((order) => order.id === args.id);
    if (found === undefined) {
      // Thrown, not returned: the dispatcher turns it into the per-op failure
      // an unknown id really is, and a fixture that answered `null` would let
      // a caller treat a missing row as an empty one.
      throw new Error(`no order with id "${String(args.id)}"`);
    }
    return Promise.resolve(found);
  },
  listInvoices: (args) => Promise.resolve(page(INVOICES, args)),
  listCustomers: (args) => Promise.resolve(page(CUSTOMERS, args)),
  getCustomer: (args) => {
    const found = CUSTOMERS.find((customer) => customer.id === args.id);
    if (found === undefined) {
      throw new Error(`no customer with id "${String(args.id)}"`);
    }
    return Promise.resolve(found);
  },
};
