import { arr, isRecord } from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";
import { looseString } from "./normalize";

/**
 * Approval-card builders for the five write actions.
 *
 * Each card answers "what is about to change in the warehouse?" for
 * someone who will never see the payload: how many entities, for which
 * warehouse customer, naming the suppliers / consignees / items involved,
 * and the dates that commit the operation. Xtent internal ids are left out
 * — per `ADDING_A_PROVIDER.md`, a number the user cannot verify is noise.
 */

type SummaryField = OperationSummaryPart["fields"][number];

const rowsOf = (value: unknown): Record<string, unknown>[] =>
  arr(value).filter(isRecord);

const optionalField = (
  labelKey: string,
  value?: string,
): SummaryField | null =>
  value === undefined || value.length === 0 ? null : { labelKey, value };

const compact = (...items: (SummaryField | null)[]): SummaryField[] =>
  items.filter((item): item is SummaryField => item !== null);

/** Distinct values of one column, capped so the card stays scannable. */
const distinct = (
  rows: Record<string, unknown>[],
  key: string,
  max = 5,
): string | undefined => {
  const seen: string[] = [];
  for (const row of rows) {
    const value = looseString(row[key]);
    if (value === undefined || seen.includes(value)) continue;
    seen.push(value);
  }
  if (seen.length === 0) return undefined;
  const shown = seen.slice(0, max).join(", ");
  return seen.length > max ? `${shown}, …` : shown;
};

const firstValue = (
  rows: Record<string, unknown>[],
  key: string,
): string | undefined => {
  for (const row of rows) {
    const value = looseString(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};

const totalLines = (rows: Record<string, unknown>[]): number =>
  rows.reduce((total, row) => total + rowsOf(row.lines).length, 0);

/** `CODE — label` pairs, so the user recognises the goods, not a key. */
const describedItems = (
  rows: Record<string, unknown>[],
  max = 5,
): string | undefined => {
  const labels: string[] = [];
  for (const row of rows.slice(0, max)) {
    const code = looseString(row.item_code);
    if (code === undefined) continue;
    const description = looseString(row.description);
    labels.push(description === undefined ? code : `${code} — ${description}`);
  }
  if (labels.length === 0) return undefined;
  return rows.length > labels.length
    ? `${labels.join(", ")}, …`
    : labels.join(", ");
};

const upsertReceptions: SummaryMapper = (args) => {
  const rows = rowsOf(args.receptions);
  return {
    titleKey: "default",
    titleParams: { count: rows.length },
    fields: compact(
      { labelKey: "count", value: rows.length.toString() },
      optionalField("warehouse_customer", distinct(rows, "client_code_id")),
      optionalField("suppliers", distinct(rows, "supplier_name")),
      optionalField(
        "planned_receiving",
        firstValue(rows, "planned_receiving_date"),
      ),
      { labelKey: "line_count", value: totalLines(rows).toString() },
    ),
  };
};

const upsertPreparations: SummaryMapper = (args) => {
  const rows = rowsOf(args.preparations);
  return {
    titleKey: "default",
    titleParams: { count: rows.length },
    fields: compact(
      { labelKey: "count", value: rows.length.toString() },
      optionalField("warehouse_customer", distinct(rows, "client_code_id")),
      optionalField("consignees", distinct(rows, "consignee_name")),
      optionalField(
        "planned_delivery",
        firstValue(rows, "planned_delivery_date"),
      ),
      { labelKey: "line_count", value: totalLines(rows).toString() },
    ),
  };
};

const upsertItems: SummaryMapper = (args) => {
  const rows = rowsOf(args.items);
  return {
    titleKey: "default",
    titleParams: { count: rows.length },
    fields: compact(
      { labelKey: "count", value: rows.length.toString() },
      optionalField("warehouse_customer", distinct(rows, "client_code_id")),
      optionalField("items", describedItems(rows)),
    ),
  };
};

const upsertParties: SummaryMapper = (args) => {
  const rows = rowsOf(args.parties);
  return {
    titleKey: "default",
    titleParams: { count: rows.length },
    fields: compact(
      { labelKey: "count", value: rows.length.toString() },
      optionalField("parties", distinct(rows, "name")),
    ),
  };
};

const changeStock: SummaryMapper = (args) => {
  const rows = rowsOf(args.stock_changes);
  return {
    titleKey: "default",
    titleParams: { count: rows.length },
    fields: compact(
      { labelKey: "count", value: rows.length.toString() },
      optionalField("warehouse_customer", distinct(rows, "client_code_id")),
      optionalField("items", distinct(rows, "item_code")),
      optionalField("pallets", distinct(rows, "pallet_number")),
      // The values the change actually writes — without them the user is
      // approving "modify 4 stock objects" with no idea into what.
      optionalField("new_stock_status", distinct(rows, "status_id")),
      optionalField("new_stock_location", distinct(rows, "location_id")),
      optionalField("new_batch", distinct(rows, "batch_number")),
      optionalField("new_quantity", distinct(rows, "sales_unit")),
      optionalField("new_expiry", distinct(rows, "expiry_date")),
      optionalField("reason", firstValue(rows, "stock_modification_label")),
    ),
  };
};

export const akaneaWmsSummaries: ProviderSummaries = {
  upsert_receptions: upsertReceptions,
  upsert_preparations: upsertPreparations,
  upsert_items: upsertItems,
  upsert_parties: upsertParties,
  change_stock: changeStock,
};
