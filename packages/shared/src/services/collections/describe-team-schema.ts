import { and, asc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinitionType } from "../../db/schema";
import { collections, fieldDefinitions, linkTypes } from "../../db/schema";
import { qualifiedCollectionTable } from "../collection-schema/identifiers";

/** One outgoing relation a type can be JOINed through (`links` → `link_types`). */
export interface TeamSchemaRelation {
  key: string;
  label: string;
  /** Target type key, or null = polymorphic (any type). */
  toCollectionKey: string | null;
}

/** One collection as the AI query path sees it: a typed view + its columns. */
export interface TeamSchemaCollection {
  /** Internal type id — used by `describeCollection` to fetch full field metadata. */
  id: string;
  key: string;
  label: string;
  labelPlural: string | null;
  description: string | null;
  isSystem: boolean;
  /** Bare Lucide icon name (or null). */
  icon: string | null;
  /** Accent color token (or null). */
  color: string | null;
  /** The real SQL table to read in `querySql` (`data.coll_<collectionId>`). */
  viewName: string;
  /**
   * Enabled fields → typed columns (besides `team_id`/`label`/`status`). The
   * field flagged `isTitle` is the one whose value feeds the record's `_label`
   * display name.
   */
  fields: { key: string; type: FieldDefinitionType; isTitle: boolean }[];
  /** Outgoing relations (this type is the `from` end). */
  relations: TeamSchemaRelation[];
}

/**
 * Describe a team's ontology for the AI query path — every collection it can
 * query, with its typed view name, field columns, and outgoing relations.
 * Powers the `<team_collections>` schema-discovery block and the `listCollections`
 * tool. Generalizes the old `<team_fields>` (which only knew document fields).
 *
 * Three reads, joined in memory: the team's visible types (its own +
 * org/system), its enabled field defs (the view columns), and its visible link
 * types (the relations). Direct queries — the per-turn caller wraps this in a
 * soft timeout and may cache.
 */
export const describeTeamSchema = async (input: {
  organizationId: string;
  teamId: string;
}): Promise<TeamSchemaCollection[]> => {
  const { organizationId, teamId } = input;

  // Visible types: the team's own + the org/system ones.
  const types = await db
    .select({
      id: collections.id,
      key: collections.key,
      label: collections.label,
      labelPlural: collections.labelPlural,
      description: collections.description,
      isSystem: collections.isSystem,
      icon: collections.icon,
      color: collections.color,
    })
    .from(collections)
    .where(
      and(
        eq(collections.organizationId, organizationId),
        eq(collections.enabled, true),
        or(eq(collections.teamId, teamId), isNull(collections.teamId)),
      ),
    )
    .orderBy(asc(collections.isSystem), asc(collections.label));

  // The team's enabled field defs (the typed view columns), grouped by type.
  const defs = await db
    .select({
      collectionId: fieldDefinitions.collectionId,
      key: fieldDefinitions.key,
      type: fieldDefinitions.type,
      isTitle: fieldDefinitions.isTitle,
    })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, teamId),
        eq(fieldDefinitions.enabled, true),
      ),
    )
    .orderBy(asc(fieldDefinitions.displayOrder));
  const fieldsByType = new Map<
    string,
    { key: string; type: FieldDefinitionType; isTitle: boolean }[]
  >();
  for (const d of defs) {
    const list = fieldsByType.get(d.collectionId) ?? [];
    list.push({ key: d.key, type: d.type, isTitle: d.isTitle });
    fieldsByType.set(d.collectionId, list);
  }

  // Visible, confirmed link types (the relations), grouped by their `from` type.
  const relations = await db
    .select({
      fromCollectionId: linkTypes.fromCollectionId,
      toCollectionId: linkTypes.toCollectionId,
      key: linkTypes.key,
      label: linkTypes.label,
    })
    .from(linkTypes)
    .where(
      and(
        eq(linkTypes.organizationId, organizationId),
        eq(linkTypes.enabled, true),
        eq(linkTypes.status, "confirmed"),
        or(eq(linkTypes.teamId, teamId), isNull(linkTypes.teamId)),
      ),
    );
  const keyById = new Map(types.map((t) => [t.id, t.key]));
  const relationsByType = new Map<string, TeamSchemaRelation[]>();
  for (const r of relations) {
    const list = relationsByType.get(r.fromCollectionId) ?? [];
    list.push({
      key: r.key,
      label: r.label,
      toCollectionKey: r.toCollectionId
        ? (keyById.get(r.toCollectionId) ?? null)
        : null,
    });
    relationsByType.set(r.fromCollectionId, list);
  }

  return types.map((t) => ({
    id: t.id,
    key: t.key,
    label: t.label,
    labelPlural: t.labelPlural,
    description: t.description,
    isSystem: t.isSystem,
    icon: t.icon,
    color: t.color,
    viewName: qualifiedCollectionTable(t.id),
    fields: fieldsByType.get(t.id) ?? [],
    relations: relationsByType.get(t.id) ?? [],
  }));
};
