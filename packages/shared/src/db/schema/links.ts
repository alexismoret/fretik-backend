import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  decimal,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";
import { collectionRecords } from "./collection-records";
import { linkTypes } from "./link-types";
import { ontologySourceEnum, ontologyStatusEnum } from "./ontology-enums";

/**
 * Links — the typed edges of the unified graph. The relation semantics live in
 * the catalog (`linkTypeId`, a NOT NULL FK), never on the row. Per-edge
 * qualifiers go in `props`. Bi-temporal columns populate only for link types
 * flagged `isTemporal` (supersession is non-destructive: set `validTo` /
 * `invalidatedAt`, insert a new row).
 *
 * Both ends are validated against the link type at write (`fromRecord` type =
 * link_type.fromCollection; `toRecord` type = link_type.toCollection unless it
 * is NULL = polymorphic).
 */
export const links = pgTable(
  "links",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Denormalized scope so RLS is a simple equality, no join.
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    linkTypeId: uuid("link_type_id")
      .notNull()
      .references(() => linkTypes.id, { onDelete: "cascade" }),
    fromRecordId: uuid("from_record_id")
      .notNull()
      .references(() => collectionRecords.id, { onDelete: "cascade" }),
    toRecordId: uuid("to_record_id")
      .notNull()
      .references(() => collectionRecords.id, { onDelete: "cascade" }),

    // Per-edge qualifiers ONLY (no semantic role column).
    props: jsonb("props")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    source: ontologySourceEnum("source").notNull().default("user_manual"),
    // Trust band, mirroring records/link-types: user edges are born `confirmed`,
    // AI-inferred ones `suggested` until reviewed (P8.4). Default keeps every
    // existing edge (and the UI/user write path) `confirmed`.
    status: ontologyStatusEnum("status").notNull().default("confirmed"),
    confidence: decimal("confidence", { precision: 4, scale: 3 }),
    // Soft ref to domain_events (append-only; see collection_records.sourceEventId).
    sourceEventId: uuid("source_event_id"),

    // Bi-temporal — NULL unless the link type is temporal.
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidatedByLinkId: uuid("invalidated_by_link_id").references(
      (): AnyPgColumn => links.id,
      { onDelete: "set null" },
    ),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("links_from_idx").on(table.fromRecordId),
    index("links_to_idx").on(table.toRecordId),
    index("links_team_type_idx").on(table.teamId, table.linkTypeId),
    index("links_props_gin_idx").using("gin", table.props),
    // At most one active edge of a type between two records.
    uniqueIndex("links_active_uniq")
      .on(table.linkTypeId, table.fromRecordId, table.toRecordId)
      .where(sql`valid_to IS NULL AND invalidated_at IS NULL`),
  ],
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;
