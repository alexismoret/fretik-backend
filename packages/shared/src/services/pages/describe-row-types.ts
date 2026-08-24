import db from "../../db";
import type { PageFieldDescriptor } from "../../schemas/pages";
import { countRecordsForType } from "../object-records/count";
import { buildPageFieldDescriptors } from "./field-descriptors";

/**
 * The row type of every object type a page is about to be built over, written
 * out before the builder asks.
 *
 * A build opens by probing: `describeObjectType` per type for the field keys and
 * the `objectTypeId` a dataset cannot be written without, then a `dry_run` for a
 * real row. The first half of that is knowable the moment the parent names the
 * types — it costs a database read, not a model step — and it is the half the
 * builder is worst at skipping, because a dataset needs an `objectTypeId` uuid
 * that is derivable from nothing.
 *
 * What this does NOT replace is the `dry_run`. Field names are a schema; whether
 * the type actually holds rows, what its distinct values look like, whether a
 * column is empty in practice — that is data, and only a query answers it.
 *
 * This goes in the sub-agent's USER message, never its system prompt: it varies
 * per call, and a varying prefix is a prefix that never hits the cache.
 */

/** `eval_page_item` → `EvalPageItemRow`. */
const rowTypeName = (key: string): string =>
  `${key
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}Row`;

/**
 * A field's value type as the page will actually receive it.
 *
 * Measured against live rows rather than the write schema — the two differ, and
 * the differences are where pages break: a rollup counts in a STRING, a relation
 * arrives as `[{id,label}]` from the links graph rather than as the uuid a write
 * would take, and `unique_id` reads as a bare number without its prefix. The
 * generic table lives in `describePageDataContract`; this names the concrete
 * type per field so the builder never has to map one onto the other.
 */
const valueType = (field: PageFieldDescriptor): string => {
  switch (field.type) {
    case "number":
    case "rating":
    case "unique_id":
      return "number";
    case "boolean":
      return "boolean";
    case "money":
      return "{ amount: number; currencyCode: string }";
    case "location":
      return "{ address: string; lat: number; lng: number }";
    case "relation":
      return "{ id: string; label: string }[]";
    case "multi_select":
      return field.options
        ? `(${field.options.map((option) => `'${option.value}'`).join(" | ")})[]`
        : "string[]";
    case "select":
      return field.options
        ? field.options.map((option) => `'${option.value}'`).join(" | ")
        : "string";
    // A formula's shape is its RESULT type, which the value cannot reveal —
    // falling through to `string` here would have the builder format a computed
    // number as text on every page that reads one.
    case "formula":
      return field.resultType === "number" || field.resultType === "boolean"
        ? field.resultType
        : "string";
    default:
      return "string";
  }
};

/** What the builder would otherwise have to infer, and would infer wrong. */
const annotation = (field: PageFieldDescriptor): string => {
  const notes: string[] = [field.type];
  if (field.isTitle) notes.push("title field");
  if (field.currencyCode) notes.push(field.currencyCode);
  if (field.type === "date") notes.push(field.hasTime ? "ISO" : "YYYY-MM-DD");
  if (field.type === "rollup") notes.push("Number() it");
  if (field.type === "formula" && field.resultType)
    notes.push(`computed, ${field.resultType}`);
  if (field.type === "unique_id" && field.prefix)
    notes.push(`display prefix ${field.prefix}`);
  if (field.writable === false) notes.push("read-only");
  if (field.sortable === false) notes.push("not sortable");
  return notes.join(", ");
};

/** One type, as a TS row type. Pure — the half that has to stay right. */
export const renderRowType = (params: {
  key: string;
  label: string;
  objectTypeId: string;
  recordCount: number;
  fields: PageFieldDescriptor[];
}): string => {
  const lines = [
    `// ${params.label} · objectTypeId: ${params.objectTypeId} · ${params.recordCount.toString()} records`,
    `type ${rowTypeName(params.key)} = {`,
    "  id: string; label: string",
  ];
  for (const field of params.fields) {
    lines.push(`  ${field.key}: ${valueType(field)}  // ${annotation(field)}`);
  }
  lines.push("}");
  return lines.join("\n");
};

/**
 * Render the row types for the given type keys, resolved exactly the way
 * `resolveObjectTypeId` resolves them: the team's own type wins, the org/system
 * one is the fallback.
 *
 * A key that resolves to nothing is NAMED rather than dropped. The parent agent
 * writes these keys from a conversation, so a wrong one is ordinary — and a
 * builder that silently receives seven types when it asked about eight designs a
 * page around the one it cannot see.
 */
export const describeRowTypes = async (params: {
  organizationId: string;
  teamId: string;
  keys: string[];
}): Promise<string> => {
  const keys = [...new Set(params.keys.map((key) => key.trim()))].filter(
    (key) => key.length > 0,
  );
  if (keys.length === 0) return "";

  const candidates = await db.query.objectTypes.findMany({
    columns: { id: true, key: true, label: true, teamId: true },
    where: {
      key: { in: keys },
      OR: [
        { teamId: params.teamId },
        { organizationId: params.organizationId, teamId: { isNull: true } },
      ],
    },
  });

  const blocks: string[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const matches = candidates.filter((type) => type.key === key);
    const type = matches.find((m) => m.teamId != null) ?? matches[0];
    if (!type) {
      unknown.push(key);
      continue;
    }
    const [fields, recordCount] = await Promise.all([
      buildPageFieldDescriptors({
        teamId: params.teamId,
        objectTypeId: type.id,
      }),
      countRecordsForType({ objectTypeId: type.id, teamId: params.teamId }),
    ]);
    if (fields.length === 0) {
      unknown.push(key);
      continue;
    }
    blocks.push(
      renderRowType({
        key,
        label: type.label,
        objectTypeId: type.id,
        recordCount,
        fields,
      }),
    );
  }

  if (blocks.length === 0 && unknown.length === 0) return "";

  const parts = [
    "The object types this page is about, as their rows will arrive. The uuids are the `objectTypeId` a dataset needs. Still `dry_run` before you design — this is the schema, not the data.",
    "",
    ...blocks,
  ];
  if (unknown.length > 0) {
    parts.push(
      "",
      `No object type for: ${unknown.join(", ")}. Find the real key in <team_objects> before building against it.`,
    );
  }
  return parts.join("\n");
};
