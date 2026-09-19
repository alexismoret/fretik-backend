import { and, asc, eq, isNull, or } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinitionType } from "../../db/schema";
import { collections, fieldDefinitions, linkTypes } from "../../db/schema";
import { qualifiedCollectionTable } from "../collection-schema/identifiers";
import { loadSyncProvenance, syncSourceIdsOf } from "./sync-provenance";

/** One outgoing relation a type can be JOINed through (`links` → `link_types`). */
export interface TeamSchemaRelation {
  key: string;
  label: string;
  /** Target type key, or null = polymorphic (any type). */
  toCollectionKey: string | null;
}

/**
 * The app behind a collection whose rows a sync source fills.
 *
 * Two things the SQL-writing agent cannot get anywhere else: these columns are
 * not ours to UPDATE, and the numbers are as old as `lastSuccessAt` — which is
 * the difference between "12 late orders" and "12 as of 09:12".
 */
export interface TeamSchemaSyncOrigin {
  app: string;
  operation: string;
  lastSuccessAt: Date | null;
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
  fields: {
    key: string;
    type: FieldDefinitionType;
    isTitle: boolean;
    /** Filled by a connected app: readable in SQL, refused on write. */
    synced?: boolean;
  }[];
  /** Outgoing relations (this type is the `from` end). */
  relations: TeamSchemaRelation[];
  /** Present when a sync source fills this collection or some of its columns. */
  syncedFrom?: TeamSchemaSyncOrigin;
}

/**
 * Describe a team's ontology for the AI query path — every collection it can
 * query, with its typed view name, field columns, and outgoing relations.
 * Powers the `<team_collections>` schema-discovery block and the `listCollections`
 * tool. Generalizes the old `<team_fields>` (which only knew document fields).
 *
 * Three reads, joined in memory: the team's visible types (its own +
 * org/system), its enabled field defs (the view columns), and its visible link
 * types (the relations) — plus a fourth ONLY when a column is fed by a
 * connected app, to say which and how fresh. Direct queries — the per-turn
 * caller wraps this in a soft timeout and may cache.
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
      syncSourceId: fieldDefinitions.syncSourceId,
    })
    .from(fieldDefinitions)
    .where(
      and(
        eq(fieldDefinitions.teamId, teamId),
        eq(fieldDefinitions.enabled, true),
      ),
    )
    .orderBy(asc(fieldDefinitions.displayOrder));
  const fieldsByType = new Map<string, TeamSchemaCollection["fields"]>();
  for (const d of defs) {
    const list = fieldsByType.get(d.collectionId) ?? [];
    list.push({
      key: d.key,
      type: d.type,
      isTitle: d.isTitle,
      // Spread, not `synced: d.syncSourceId !== null`: under
      // `exactOptionalPropertyTypes` an explicit `false` is a key the renderer
      // then has to skip, and this object is rendered every turn.
      ...(d.syncSourceId === null ? {} : { synced: true as const }),
    });
    fieldsByType.set(d.collectionId, list);
  }

  // A FOURTH read, and only when something is actually synced — the ids come
  // from the field defs already in hand, so a workspace with no sync source
  // pays nothing for this block.
  const syncSources = await loadSyncProvenance(syncSourceIdsOf(defs));
  const syncByCollection = new Map<string, TeamSchemaSyncOrigin>();
  for (const source of syncSources.values()) {
    // A collection has at most one `table` source (it owns the rows) and may
    // have several `lookup` ones. The table source is the one that explains
    // where the collection came FROM, so it wins; otherwise the first lookup
    // stands in, and the per-field `synced` flags carry the rest.
    const current = syncByCollection.get(source.collectionId);
    if (current !== undefined && source.kind !== "table") continue;
    syncByCollection.set(source.collectionId, {
      app: source.app,
      operation: source.operation,
      lastSuccessAt: source.lastSuccessAt,
    });
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

  return types.map((t) => {
    // Spread over assignment: `exactOptionalPropertyTypes` makes an explicit
    // `syncedFrom: undefined` a different type from an absent key.
    const syncedFrom = syncByCollection.get(t.id);
    return {
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
      ...(syncedFrom === undefined ? {} : { syncedFrom }),
    };
  });
};
