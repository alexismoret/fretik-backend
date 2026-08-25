import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  decimal,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { collections } from "./collections";
import { ontologySourceEnum, ontologyStatusEnum } from "./ontology-enums";

/**
 * Structural cardinality of a relation. The ONLY enum on link types — it is
 * structural, not business. Relation *semantics* live in `key`/`label`, never
 * an enum.
 */
export const linkTypeCardinalityEnum = pgEnum("link_type_cardinality", [
  "one_to_one",
  "one_to_many",
  "many_to_many",
]);

/**
 * Link types — the catalog of typed relations between collections
 * (`pricing → carrier → organization`). Created by users OR the AI. A `link`
 * row carries no semantics of its own; it points at a link type via a NOT NULL
 * FK. Per-edge qualifiers go in `links.props`.
 *
 * `toCollectionId` is NULLABLE → a polymorphic relation (Twenty-style): the
 * target record may be of any type (e.g. a note attachable to several types).
 *
 * Lifecycle (status/source/confidence) mirrors records so the AI can propose a
 * relation as `suggested`; it MUST first canonicalize against existing link
 * types (trigram + embedding over `normalizedKey`) to avoid predicate sprawl
 * (`works_for` vs `employed_by`).
 */
export const linkTypes = pgTable(
  "link_types",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    // NULL = organization/system scope, set = team scope
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    key: varchar("key", { length: 60 }).notNull(),
    // Lowercased/slugified key — the canonicalization + uniqueness target.
    normalizedKey: varchar("normalized_key", { length: 60 }).notNull(),
    label: text("label").notNull(),

    fromCollectionId: uuid("from_collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    // NULL = polymorphic (target may be any collection)
    toCollectionId: uuid("to_collection_id").references(() => collections.id, {
      onDelete: "cascade",
    }),

    // Naming of the reverse traversal (display only).
    inverseKey: varchar("inverse_key", { length: 60 }),
    inverseLabel: text("inverse_label"),

    cardinality: linkTypeCardinalityEnum("cardinality")
      .notNull()
      .default("many_to_many"),

    // Opt-in bi-temporal edges (Graphiti/Zep). When true, `links` of this type
    // record validity intervals and supersede non-destructively.
    isTemporal: boolean("is_temporal").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),

    // Lifecycle / trust
    status: ontologyStatusEnum("status").notNull().default("confirmed"),
    source: ontologySourceEnum("source").notNull().default("user_manual"),
    confidence: decimal("confidence", { precision: 4, scale: 3 }),
    // RESERVED — de-dup target when two confirmed relation types are found
    // equivalent; the loser points here.
    mergedIntoId: uuid("merged_into_id").references(
      (): AnyPgColumn => linkTypes.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // A predicate is unique PER SOURCE TYPE, not per scope. `fromCollectionId`
    // is load-bearing here: without it the constraint contradicted everything
    // that reads these rows — `resolveLinkType` looks up scoped by source type,
    // `bulkCreateLinks` validates an edge's endpoints against the link type's
    // declared types, and the extractor's `<known_relations>` catalog is scoped
    // the same way. A team that already had `supplies` on one type therefore
    // could never gain `supplies` on another: the lookup (scoped) found
    // nothing, the insert (unscoped) hit this index, and `extract-relations`
    // threw. Measured 2026-08-03 at 10/10 on `mem-relation-explicit`, and
    // SILENT in production — the memory-resolve worker catches it and logs
    // "relation extraction unavailable", losing the whole pass for that event.
    uniqueIndex("link_types_org_key_uniq")
      .on(table.organizationId, table.normalizedKey, table.fromCollectionId)
      .where(sql`team_id IS NULL`),
    uniqueIndex("link_types_team_key_uniq")
      .on(table.teamId, table.normalizedKey, table.fromCollectionId)
      .where(sql`team_id IS NOT NULL`),
    index("link_types_org_idx").on(table.organizationId),
    index("link_types_team_idx").on(table.teamId),
    index("link_types_from_idx").on(table.fromCollectionId),
    index("link_types_to_idx").on(table.toCollectionId),
  ],
);

export type LinkType = typeof linkTypes.$inferSelect;
export type NewLinkType = typeof linkTypes.$inferInsert;
export type LinkTypeCardinality = LinkType["cardinality"];
