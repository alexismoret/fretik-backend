import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { organization, team } from "./auth-schema";

/**
 * Object types — the runtime-defined catalog of "what kinds of things a team
 * tracks" (the ontology). Each row is a type like `client`, `pricing`,
 * `document`, `organization`. Field definitions, link types, records, and
 * action types all hang off an object type.
 *
 * Scope semantics (mirrors `field_definitions`):
 *   - `teamId IS NULL` → organization-level type. System types
 *     (`isSystem = true`: document/organization/person) live here, shared by
 *     every team in the org; org templates also live here.
 *   - `teamId IS NOT NULL` → team-level type created by a team (user or AI).
 *
 * Reads use the double arm `teamId = $team OR (teamId IS NULL AND
 * organizationId = $org)` so a team sees its own types plus the org/system
 * ones — the same shape the SQL-tool RLS policy uses.
 */
export const objectTypes = pgTable(
  "object_types",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    // NULL = organization/system scope, set = team scope
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    // Stable slug — drives the typed view name `v_<key>` and the SQL the agent
    // writes. Strictly slugified in the service layer (anti-DDL-injection).
    key: varchar("key", { length: 60 }).notNull(),
    label: text("label").notNull(),
    labelPlural: text("label_plural"),
    // User-facing AND the type-level hint surfaced to the agent in the schema
    // discovery block.
    description: text("description"),
    icon: varchar("icon", { length: 60 }),
    color: varchar("color", { length: 20 }),

    // System types (document/organization/person) are AI/ingestion-managed:
    // the user cannot delete them or rename their core fields.
    isSystem: boolean("is_system").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),

    // Whether this type's records carry a semantic card in `ai_vectors`.
    // NULL (the default) = decide from the row count, see
    // `services/object-records/card-indexing-policy.ts`. Set explicitly to
    // override the size heuristic in either direction: `true` keeps a huge
    // type embedded, `false` takes a small noisy one out of recall. Nullable
    // on purpose — a plain boolean could not tell "auto, currently on" from
    // "the user asked for on", and only the second must survive growth.
    semanticIndex: boolean("semantic_index"),

    // RESERVED — Directus-style per-type / per-field ACL. Unused in V1, present
    // so team-level RLS can later be refined to "per-métier views" without a
    // migration.
    visibility: jsonb("visibility")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // One (key) per org at org scope, one (key) per team at team scope.
    uniqueIndex("object_types_org_key_uniq")
      .on(table.organizationId, table.key)
      .where(sql`team_id IS NULL`),
    uniqueIndex("object_types_team_key_uniq")
      .on(table.teamId, table.key)
      .where(sql`team_id IS NOT NULL`),
    index("object_types_org_idx").on(table.organizationId),
    index("object_types_team_idx").on(table.teamId),
  ],
);

export type ObjectType = typeof objectTypes.$inferSelect;
export type NewObjectType = typeof objectTypes.$inferInsert;
