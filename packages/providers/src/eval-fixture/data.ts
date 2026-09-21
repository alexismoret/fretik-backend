/**
 * The rows this fixture serves. In memory, deterministic, no network.
 *
 * They are shaped to line up with `evals/cases/collections-autonomy.ts`, and
 * the two sides have to be read together:
 *
 *  - `ORDERS[*].reference` matches the records that suite seeds into
 *    `eval_sync_orders` (`EV-1001`, `EV-1002`), so a `table` source over
 *    `list_orders` updates them instead of creating a third and a fourth.
 *  - `INVOICES[*].order_reference` points back at those same references, which
 *    is what makes a SECOND app able to fill a column on the same collection
 *    keyed on a value the first app already wrote.
 *  - `CUSTOMERS[*].code` matches the `code` column of the hand-typed
 *    `eval_sync_clients` collection (`CL-001` … `CL-003`), the case for a
 *    `columns` source walked over a list and matched on an existing column.
 *
 * `CUSTOMERS` deliberately holds one row (`CL-999`) that no record here
 * carries: a walk must report it `unmatched` rather than inventing a record,
 * and a fixture where everything matches cannot show the difference.
 */

export interface EvalOrder {
  id: string;
  reference: string;
  amount: number;
  status: string;
  client_code: string;
  updated_at: string;
}

export interface EvalInvoice {
  id: string;
  order_reference: string;
  payment_status: string;
  due_date: string;
}

export interface EvalCustomer {
  id: string;
  code: string;
  name: string;
  email: string;
  phone: string;
}

/**
 * Fixed timestamps, never `new Date()`.
 *
 * Three of the sync cases turn on how OLD the data is, and a fixture that
 * stamps itself at call time makes that age depend on when the suite happened
 * to run. The same reasoning as the seed's hand-written `last_success_at`.
 */
const UPDATED_AT = "2026-09-19T09:14:19.000Z";

export const ORDERS: readonly EvalOrder[] = [
  {
    id: "ord_1001",
    reference: "EV-1001",
    amount: 1200,
    status: "confirmed",
    client_code: "CL-001",
    updated_at: UPDATED_AT,
  },
  {
    id: "ord_1002",
    reference: "EV-1002",
    amount: 800,
    status: "confirmed",
    client_code: "CL-002",
    updated_at: UPDATED_AT,
  },
  {
    id: "ord_1003",
    reference: "EV-1003",
    amount: 450,
    status: "draft",
    client_code: "CL-003",
    updated_at: UPDATED_AT,
  },
];

export const INVOICES: readonly EvalInvoice[] = [
  {
    id: "inv_5001",
    order_reference: "EV-1001",
    payment_status: "paid",
    due_date: "2026-09-10",
  },
  {
    id: "inv_5002",
    order_reference: "EV-1002",
    payment_status: "overdue",
    due_date: "2026-09-01",
  },
  {
    id: "inv_5003",
    order_reference: "EV-1003",
    payment_status: "pending",
    due_date: "2026-10-05",
  },
];

export const CUSTOMERS: readonly EvalCustomer[] = [
  {
    id: "cus_001",
    code: "CL-001",
    name: "Eval Client Nord",
    email: "nord@example.invalid",
    phone: "+33100000001",
  },
  {
    id: "cus_002",
    code: "CL-002",
    name: "Eval Client Sud",
    email: "sud@example.invalid",
    phone: "+33100000002",
  },
  {
    id: "cus_003",
    code: "CL-003",
    name: "Eval Client Est",
    email: "est@example.invalid",
    phone: "+33100000003",
  },
  {
    id: "cus_999",
    code: "CL-999",
    name: "Eval Client Ouest",
    email: "ouest@example.invalid",
    phone: "+33100000999",
  },
];
