import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  ACCESS_LEVELS,
  ACCESS_PRINCIPAL_TYPES,
  ACCESS_REQUEST_STATUSES,
  ACCESS_RESOURCE_TYPES,
  TEAM_ROLES,
} from "../../schemas/access";
import { organization, team, teamMember, user } from "./auth-schema";

/**
 * Access control — the tables behind `@fretik/shared/authz`.
 *
 * Who may do what is answered in ONE place (`authz/`), from four sources:
 *
 *   - the organization role (`member.role`, owned by Better Auth);
 *   - the TEAM role (`team_member_roles` below — Better Auth has none);
 *   - the resource's own facts: its owner, its container (team, project) and
 *     whether it is restricted to the people it is shared with;
 *   - explicit grants (`access_grants` below), plus the grant tables that
 *     predate them and keep their meaning (`ai_conversation_members`,
 *     `collection_grants`, `record_shares`).
 *
 * Access is additive — the highest path wins, there is no deny rule. To narrow
 * what a container gives, a resource is marked restricted: it stops inheriting
 * and only its owner and its grants reach it.
 */

/**
 * The four levels, weakest first (`schemas/access.ts`). The declaration order
 * is load-bearing: Postgres compares enum values by it, so `level >= 'edit'`
 * is a valid predicate and the accessible-row filters rely on it.
 *
 *   view — open, read, download
 *   use  — take part: chat in a conversation, run a workflow, fill a page form
 *   edit — change the content
 *   full — share, move, delete; what an owner has
 */
export const accessLevelEnum = pgEnum("access_level", [...ACCESS_LEVELS]);

/** Everything a grant can be attached to. */
export const accessResourceTypeEnum = pgEnum("access_resource_type", [
  ...ACCESS_RESOURCE_TYPES,
]);

/**
 * Who a grant is for. `invitation` is a guest who has not accepted yet: the
 * grant is converted to a `user` grant when they do, and until then it gives
 * nobody anything.
 */
export const accessPrincipalTypeEnum = pgEnum("access_principal_type", [
  ...ACCESS_PRINCIPAL_TYPES,
]);

/**
 * A person's role in ONE team. Organization admins and owners are leads of
 * every team of their organization without a row here: they run the
 * structure, which is not the same as reading everyone's private work.
 */
export const teamRoleEnum = pgEnum("team_role", [...TEAM_ROLES]);

export const accessRequestStatusEnum = pgEnum("access_request_status", [
  ...ACCESS_REQUEST_STATUSES,
]);

/**
 * The team role of one `team_member` row.
 *
 * Keyed by the membership rather than by (team, user): the row goes with the
 * membership (`cascade`), so leaving a team and coming back starts from the
 * default again instead of resurrecting an old lead role.
 *
 * NO ROW MEANS `member`. Better Auth writes `team_member` itself (invitation
 * accepted, `addTeamMember`) and knows nothing of this table, so the default
 * cannot depend on a second insert that one of those paths would forget.
 * Only a lead or a viewer needs a row; a `member` row is harmless.
 *
 * Not a `teamMember.role` column: that is the exact name an open Better Auth
 * proposal would add to its own table, and the two would collide.
 */
export const teamMemberRoles = pgTable(
  "team_member_roles",
  {
    teamMemberId: uuid("team_member_id")
      .primaryKey()
      .references(() => teamMember.id, { onDelete: "cascade" }),
    // Denormalised from the membership so a principal loads in one query.
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    role: teamRoleEnum("role").notNull().default("member"),

    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedByUserId: uuid("updated_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("team_member_roles_user_idx").on(table.userId),
    index("team_member_roles_team_idx").on(table.teamId),
  ],
);

/**
 * A project: a subject a team works on (a client, a case, a topic), with its
 * own conversations, files, pages and workflows, its own instructions for the
 * assistant, and its own members.
 *
 * A project belongs to ONE team, which pays for it and whose settings it
 * uses; it can still welcome people from other teams and guests, through
 * grants on the project. `accessRestricted = false` means every member of the
 * team sees it; `true` means only its members do.
 *
 * Content points here through `project_id` with the default `NO ACTION`
 * foreign key: deleting a project that still holds content fails instead of
 * silently handing that content to the whole team. The delete service empties
 * it first; a team deletion cascades both sides in one statement, which
 * `NO ACTION` allows.
 */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    /** Read by the assistant on every turn of a conversation in the project. */
    instructions: text("instructions").notNull().default(""),
    /** A Lucide icon name (`i-lucide-…`), or null for the default glyph. */
    icon: varchar("icon", { length: 64 }),
    /** A Nuxt UI color name, or null for the neutral default. */
    color: varchar("color", { length: 32 }),

    ownerUserId: uuid("owner_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    accessRestricted: boolean("access_restricted").notNull().default(false),

    archivedAt: timestamp("archived_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("projects_team_idx").on(table.teamId),
    index("projects_org_idx").on(table.organizationId),
  ],
);

/**
 * One explicit grant: `principal` has `level` on `resource`.
 *
 * Polymorphic on both ends, so neither end carries a foreign key; the rows of
 * a deleted resource or principal are removed by the triggers of the
 * migration that creates this table (`access_grants_cleanup_*`). A grant left
 * behind would give nothing — the resource is gone, or the principal can no
 * longer sign in — but it would read wrong in every "who has access" list.
 *
 * `principal_type = organization` carries the organization id as its
 * principal: "everyone in the organization", guests excepted.
 */
export const accessGrants = pgTable(
  "access_grants",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    resourceType: accessResourceTypeEnum("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),

    principalType: accessPrincipalTypeEnum("principal_type").notNull(),
    principalId: uuid("principal_id").notNull(),

    level: accessLevelEnum("level").notNull(),

    grantedByUserId: uuid("granted_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** Past this instant the grant gives nothing (guests' access duration). */
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // One grant per (resource, principal): changing a level updates the row.
    uniqueIndex("access_grants_resource_principal_uidx").on(
      table.resourceType,
      table.resourceId,
      table.principalType,
      table.principalId,
    ),
    // "What is shared with me" and the accessible-row filters start here.
    index("access_grants_principal_idx").on(
      table.principalType,
      table.principalId,
    ),
    index("access_grants_org_idx").on(table.organizationId),
  ],
);

/**
 * "Ask for access": a person asks for a level on a resource, or for a
 * capability their role or a policy withholds. Whoever may grant it (the
 * resource's full-access holders, or an admin for a capability) approves or
 * denies; approving a resource request writes the grant.
 */
export const accessRequests = pgTable(
  "access_requests",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    requesterUserId: uuid("requester_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** Set for a resource request; null for a capability request. */
    resourceType: accessResourceTypeEnum("resource_type"),
    resourceId: uuid("resource_id"),
    requestedLevel: accessLevelEnum("requested_level"),

    /** Set for a capability request (`teams.create`, …); null otherwise. */
    capability: varchar("capability", { length: 64 }),
    /** The team a team-scoped capability was asked in. */
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),

    message: text("message"),

    status: accessRequestStatusEnum("status").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamp("decided_at", { mode: "date", withTimezone: true }),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    // Asking twice while the first request waits is the same request.
    uniqueIndex("access_requests_pending_resource_uidx")
      .on(table.requesterUserId, table.resourceType, table.resourceId)
      .where(sql`status = 'pending' AND resource_id IS NOT NULL`),
    uniqueIndex("access_requests_pending_capability_uidx")
      .on(table.requesterUserId, table.capability)
      .where(sql`status = 'pending' AND capability IS NOT NULL`),
    index("access_requests_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    index("access_requests_resource_idx").on(
      table.resourceType,
      table.resourceId,
    ),
  ],
);

/**
 * The organization's access journal: every change to who may do what:
 * memberships, invitations, teams, grants, restrictions, requests, projects,
 * policies. Written next to each change (`services/access/record-event.ts`),
 * never from a trigger, because the actor and the reason live in the request;
 * read by the organization's admins (`services/access/journal/`).
 *
 * Append-only. The actor is `set null` so the trail outlives the people in it,
 * like `auth_audit_log`.
 */
export const accessAuditLog = pgTable(
  "access_audit_log",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    /** `grant.created`, `team_role.changed`, `policy.updated`, … */
    action: varchar("action", { length: 64 }).notNull(),

    resourceType: accessResourceTypeEnum("resource_type"),
    resourceId: uuid("resource_id"),
    principalType: accessPrincipalTypeEnum("principal_type"),
    principalId: uuid("principal_id"),

    /** The before/after of the change, names resolved at write time. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("access_audit_log_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export type Project = typeof projects.$inferSelect;
export type AccessGrant = typeof accessGrants.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
