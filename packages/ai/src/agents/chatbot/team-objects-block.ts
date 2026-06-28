import type { TeamSchemaObjectType } from "@fretik/shared/services/object-types/describe-team-schema";

/**
 * Render the `<team_objects>` dynamic-suffix block: one line per object type the
 * team has — its purpose (description), typed table, field columns, and outgoing
 * relations. The description tells the agent what each type is FOR; full field
 * metadata (options, bounds, per-field descriptions) is one `describeObjectType`
 * call away.
 *
 * Format per type:
 *   `- **key** (Plural) — <description>. table \`data.obj_…\`; columns: id, _label, _status, a (number); relations: rel → target`
 * The model SELECTs FROM the table, so the columns are the EXACT queryable names:
 * the system columns `id, _label, _status, created_at, updated_at` lead every
 * list (the agent kept guessing bare `label`/`status`, a non-existent `name`, or
 * `created_at` on the wrong place). `_label` is the record's display name; the
 * field that feeds it is tagged `, title` so the agent never invents a `name`
 * column. A `money` field `k` is shown as its two real columns `k_amount,
 * k_currency`. `source` / `document_id` still live on `object_records` (join on
 * `id`) — see `<sql_rules>`. Returns "" when the team has no types.
 *
 * BOUNDED — this block lives in the dynamic suffix, re-rendered EVERY turn and
 * NOT prefix-cached, so its size is a real per-turn cost. Two guards keep it flat
 * regardless of how many types/fields a team accumulates:
 *  - per type: at most `MAX_COLS_PER_TYPE` columns, the rest folded into
 *    `+N more (describeObjectType)`;
 *  - whole block: once `CHAR_BUDGET` is reached, remaining types degrade to a
 *    compact `key (Plural) — purpose` line (no columns/relations) and, past that,
 *    to a trailing `+N more types` count.
 * The full schema of any type is always reachable through `describeObjectType`,
 * so degradation never hides a type — it just defers its columns to a tool call.
 */
const MAX_COLS_PER_TYPE = 12;
const CHAR_BUDGET = 3500;

const purposeOf = (t: TeamSchemaObjectType): string =>
  t.description ? ` — ${t.description.replace(/\.$/, "")}` : "";

const pluralOf = (t: TeamSchemaObjectType): string =>
  t.labelPlural ? ` (${t.labelPlural})` : "";

/**
 * The exact SQL column token(s) for a field. Identity for scalars; a `money`
 * field is two columns (`k_amount`, `k_currency`) — selecting the bare key
 * fails, so render both. relation/rollup are not columns (graph / computed).
 */
const columnsForField = (f: {
  key: string;
  type: string;
  isTitle: boolean;
}): string => {
  // The title field carries the record's display name; its value is mirrored
  // into `_label`. Mark it so the agent filters on `_label` (or this key)
  // instead of guessing a bare `name`/`title` column.
  const title = f.isTitle ? ", title" : "";
  if (f.type === "money")
    return `${f.key}_amount, ${f.key}_currency (money${title})`;
  if (f.type === "relation" || f.type === "rollup") return "";
  return `${f.key} (${f.type}${title})`;
};

/** Full line: purpose + system columns + capped field columns + relations. */
const fullLine = (t: TeamSchemaObjectType): string => {
  const shown = t.fields.slice(0, MAX_COLS_PER_TYPE);
  const overflow = t.fields.length - shown.length;
  const fieldCols = shown.map(columnsForField).filter(Boolean);
  // Lead with the system columns the agent must use (it kept guessing bare
  // `label`/`status`, a non-existent `name`, or `created_at` on the registry).
  const cols =
    `id, _label, _status, created_at, updated_at` +
    (fieldCols.length > 0 ? `, ${fieldCols.join(", ")}` : "") +
    (overflow > 0 ? `, +${overflow.toString()} more (describeObjectType)` : "");
  const relations =
    t.relations.length > 0
      ? t.relations.map((r) => `${r.key} → ${r.toTypeKey ?? "any"}`).join(", ")
      : "—";
  return `- **${t.key}**${pluralOf(t)}${purposeOf(t)}. table \`${t.viewName}\`; columns: ${cols}; relations: ${relations}`;
};

/** Compact line: purpose only, columns deferred to describeObjectType. */
const compactLine = (t: TeamSchemaObjectType): string =>
  `- **${t.key}**${pluralOf(t)}${purposeOf(t)}. (describeObjectType for fields)`;

export const formatTeamObjectsBlock = (
  types: TeamSchemaObjectType[],
): string => {
  if (types.length === 0) return "";

  const lines: string[] = [];
  let chars = 0;
  let i = 0;
  // Pass 1: full lines until the budget is spent.
  for (; i < types.length; i++) {
    const t = types[i];
    if (!t) continue;
    const line = fullLine(t);
    if (chars + line.length > CHAR_BUDGET && lines.length > 0) break;
    lines.push(line);
    chars += line.length + 1;
  }
  // Pass 2: remaining types degrade to compact lines until budget, then a count.
  for (; i < types.length; i++) {
    const t = types[i];
    if (!t) continue;
    const line = compactLine(t);
    if (chars + line.length > CHAR_BUDGET) {
      lines.push(
        `- +${(types.length - i).toString()} more types (describeObjectType)`,
      );
      break;
    }
    lines.push(line);
    chars += line.length + 1;
  }
  return lines.join("\n");
};
