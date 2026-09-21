import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * The provider the eval suites call.
 *
 * It answers from memory (`data.ts`) and reaches no network, which is what lets
 * `evals/cases/collections-autonomy.ts` exercise the REAL path — catalogue,
 * generated SKILL + SDK, `resolveSyncAction`, the walker, the governor, the
 * diff — against an app that actually replies. `testOnly` keeps it out of the
 * connect catalogue and out of the credential fetch; see that field's comment
 * in `manifest-schema.ts` for the three runs that made it necessary.
 *
 * The action set is chosen to make the decisions those cases grade REAL rather
 * than forced:
 *
 *  - `list_orders` and `get_order` are the same entity twice — a paginated list
 *    and a single-record read — so "walk the list or ask per record" is a
 *    choice the agent can get wrong. A provider offering only one of them would
 *    decide it for them.
 *  - `list_customers` / `get_customer` repeat that pair for a `columns` source
 *    matched on a column the team already types.
 *  - `list_invoices` is the SECOND app's surface: it keys on
 *    `order_reference`, a value the first source already wrote, which is how
 *    two apps end up filling one collection.
 *
 * `list_orders` declares `incremental`, and the handler honours it. A fixture
 * that accepted `updated_after` and returned everything anyway would hide the
 * exact defect `assert-since-binding.ts` exists to catch.
 */
export const evalFixtureManifest: ProviderManifest = {
  key: "eval-fixture",
  displayName: "Eval Fixture",
  description:
    "Eval Fixture — a test double that serves a fixed set of orders, invoices and customers from memory. Not a real app: it exists so the eval suites can read an app that answers.",
  // Never used — `testOnly` short-circuits the credential fetch — but the field
  // is required of every manifest and an empty string would not parse.
  nangoProviderConfigKey: "eval-fixture",
  icon: "i-lucide-flask-conical",
  iconColor: "#6B7280",
  transport: { kind: "custom-handler" },
  testOnly: true,
  categories: ["data"],
  scopes: [],
  types: {
    Order: {
      id: { type: "string", description: "Stable upstream id" },
      reference: {
        type: "string",
        description: "Human reference, e.g. EV-1001",
      },
      amount: { type: "number", description: "Order total" },
      status: {
        type: "enum",
        values: ["draft", "confirmed", "cancelled"],
        description: "Where the order stands",
      },
      client_code: {
        type: "string",
        description: "Code of the customer this order belongs to",
      },
      updated_at: { type: "datetime", description: "Last change upstream" },
    },
    Invoice: {
      id: { type: "string", description: "Stable upstream id" },
      order_reference: {
        type: "string",
        description: "Reference of the order this invoice bills",
      },
      payment_status: {
        type: "enum",
        values: ["pending", "paid", "overdue"],
        description: "Whether the invoice has been settled",
      },
      due_date: { type: "date", description: "When payment is due" },
    },
    Customer: {
      id: { type: "string", description: "Stable upstream id" },
      code: { type: "string", description: "Customer code, e.g. CL-001" },
      name: { type: "string" },
      email: { type: "email" },
      phone: { type: "string" },
    },
  },
  actions: [
    {
      name: "list_orders",
      kind: "read",
      summary: "List orders, newest first",
      handler: "listOrders",
      params: {
        limit: {
          type: "integer",
          min: 1,
          max: 100,
          default: 50,
          optional: true,
        },
        offset: { type: "integer", min: 0, default: 0, optional: true },
        updated_after: {
          type: "datetime",
          optional: true,
          description: "Only orders changed at or after this instant",
        },
      },
      pagination: { kind: "offset", maxLimit: 100 },
      incremental: { param: "updated_after", format: "iso" },
      returns: { list: "Order" },
    },
    {
      name: "get_order",
      kind: "read",
      summary: "Fetch one order by id",
      handler: "getOrder",
      params: { id: { type: "string" } },
      returns: { ref: "Order" },
    },
    {
      name: "list_invoices",
      kind: "read",
      summary:
        "List invoices, each carrying the reference of the order it bills",
      handler: "listInvoices",
      params: {
        limit: {
          type: "integer",
          min: 1,
          max: 100,
          default: 50,
          optional: true,
        },
        offset: { type: "integer", min: 0, default: 0, optional: true },
      },
      pagination: { kind: "offset", maxLimit: 100 },
      returns: { list: "Invoice" },
    },
    {
      name: "list_customers",
      kind: "read",
      summary: "List customers",
      handler: "listCustomers",
      params: {
        limit: {
          type: "integer",
          min: 1,
          max: 100,
          default: 50,
          optional: true,
        },
        offset: { type: "integer", min: 0, default: 0, optional: true },
      },
      pagination: { kind: "offset", maxLimit: 100 },
      returns: { list: "Customer" },
    },
    {
      name: "get_customer",
      kind: "read",
      summary: "Fetch one customer by id",
      handler: "getCustomer",
      params: { id: { type: "string" } },
      returns: { ref: "Customer" },
    },
  ],
};
