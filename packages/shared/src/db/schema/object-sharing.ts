import { sql } from "drizzle-orm";
import {
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";
import { objectRecords } from "./object-records";
import { objectTypes } from "./object-types";

/**
 * Object sharing — the cross-team ACL layer of the objects system.
 *
 * Tenancy is a COLUMN, not a schema boundary: every record is owned by a team
 * (`object_records.team_id`) and is private to it by default. Sharing is layered
 * on top via two grant tables, at two granularities:
 *   - `object_grants`  → share a whole object type (its table) with another team.
 *   - `record_shares`  → share a single record with another team.
 *
 * Both are consulted by the row-level-security predicate on `object_records`
 * (see the `fretik_has_grant` helper): a team sees a row if it owns it
 * (indexed-equality fast path) OR a grant/share makes it visible. A NULL
 * `granteeTeamId` means "all teams in the organization" (org-wide share).
 *
 * No Zanzibar/ReBAC: relationships live in these two tables in the same DB,
 * single app — a grants table + RLS is the right weight.
 */

/** Access a grant confers. `write` implies `read`. */
export const objectPermissionEnum = pgEnum("object_permission", [
  "read",
  "write",
]);

export const OBJECT_PERMISSIONS = objectPermissionEnum.enumValues;
export type ObjectPermission = (typeof OBJECT_PERMISSIONS)[number];

/**
 * Object-type-level grants — "team A shares its whole `client` type with team B"
 * (or org-wide). Visibility/usage of every record of the type follows the grant.
 */
export const objectGrants = pgTable(
  "object_grants",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    objectTypeId: uuid("object_type_id")
      .notNull()
      .references(() => objectTypes.id, { onDelete: "cascade" }),

    // The team that owns the type and granted access (for "what have I shared").
    ownerTeamId: uuid("owner_team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // The team the type is shared WITH. NULL = every team in the organization.
    granteeTeamId: uuid("grantee_team_id").references(() => team.id, {
      onDelete: "cascade",
    }),

    permission: objectPermissionEnum("permission").notNull().default("read"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    // One grant per (type, grantee). Two partials because Postgres treats NULL
    // grantee (org-wide) as distinct in a plain UNIQUE.
    uniqueIndex("object_grants_type_grantee_uniq")
      .on(table.objectTypeId, table.granteeTeamId)
      .where(sql`grantee_team_id IS NOT NULL`),
    uniqueIndex("object_grants_type_orgwide_uniq")
      .on(table.objectTypeId)
      .where(sql`grantee_team_id IS NULL`),
    // RLS hot path: "is this type granted to my team (or org-wide)?".
    index("object_grants_grantee_idx").on(table.granteeTeamId),
    index("object_grants_type_idx").on(table.objectTypeId),
  ],
);

/**
 * Record-level shares — "team A shares THIS one client with team B" (or
 * org-wide). Finer than `object_grants`: visibility is per row.
 */
export const recordShares = pgTable(
  "record_shares",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    recordId: uuid("record_id")
      .notNull()
      .references(() => objectRecords.id, { onDelete: "cascade" }),

    ownerTeamId: uuid("owner_team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // NULL = every team in the organization.
    granteeTeamId: uuid("grantee_team_id").references(() => team.id, {
      onDelete: "cascade",
    }),

    permission: objectPermissionEnum("permission").notNull().default("read"),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("record_shares_record_grantee_uniq")
      .on(table.recordId, table.granteeTeamId)
      .where(sql`grantee_team_id IS NOT NULL`),
    uniqueIndex("record_shares_record_orgwide_uniq")
      .on(table.recordId)
      .where(sql`grantee_team_id IS NULL`),
    index("record_shares_grantee_idx").on(table.granteeTeamId),
    index("record_shares_record_idx").on(table.recordId),
  ],
);

export type ObjectGrant = typeof objectGrants.$inferSelect;
export type NewObjectGrant = typeof objectGrants.$inferInsert;
export type RecordShare = typeof recordShares.$inferSelect;
export type NewRecordShare = typeof recordShares.$inferInsert;
