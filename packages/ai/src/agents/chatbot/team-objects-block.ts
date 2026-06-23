import type { TeamSchemaObjectType } from "@fretik/shared/services/object-types/describe-team-schema";

/**
 * Render the `<team_objects>` dynamic-suffix block: one line per object type the
 * team can query, with its typed SQL view, field columns, and outgoing
 * relations. Generalizes the old `<team_fields>` (document fields only).
 *
 * Format per type: `- **key** (view \`v_…\`) — columns: a (number), b (text). relations: rel → target`.
 * The model SELECTs FROM the view; structural columns (`_id`, `_label`,
 * `_status`) are documented once in the prompt, not repeated per type. Returns ""
 * when the team has no types, so the renderer shows the empty placeholder.
 */
export const formatTeamObjectsBlock = (
  types: TeamSchemaObjectType[],
): string => {
  if (types.length === 0) return "";
  return types
    .map((t) => {
      const columns =
        t.fields.length > 0
          ? t.fields.map((f) => `${f.key} (${f.type})`).join(", ")
          : "—";
      const relations =
        t.relations.length > 0
          ? t.relations
              .map((r) => `${r.key} → ${r.toTypeKey ?? "any"}`)
              .join(", ")
          : "—";
      return `- **${t.key}** (view \`${t.viewName}\`) — columns: ${columns}. relations: ${relations}`;
    })
    .join("\n");
};
