import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * What a pin can point at. Deliberately a small closed enum rather than a
 * free-form string: the sidebar has to know how to build a route for every
 * target it renders, so a target kind nobody can navigate to must not be
 * storable in the first place.
 */
export const userPinTargetEnum = pgEnum("user_pin_target", [
  "collection",
  "page",
  "workflow",
]);

/**
 * Per-user sidebar pins — "keep this collection / page / workflow one click
 * away".
 *
 * PER USER, not per team: a pin is a personal shortcut, the same way
 * `ai_context_user_file_mutes` is a personal override on a shared resource.
 * Two colleagues in the same team curate different sidebars, and pinning
 * something never changes what anyone else sees.
 *
 * `teamId` is NOT NULL because a pin IS a sidebar entry and the sidebar only
 * exists inside an active team. An org-scoped system collection (`collections.
 * teamId IS NULL`) pinned while working in team A is pinned in team A only —
 * switching teams switches sidebars, which is what a per-team workspace means.
 * `organizationId` is denormalised alongside it as a second lock on scope, so
 * a read can filter by scope without joining `team`.
 *
 * `targetId` carries NO foreign key: one generic column cannot reference
 * several parents. Orphans are handled from both ends instead —
 * `services/pins/cleanup.ts` reaps the rows inside the deleting transaction
 * (`services/collections/delete.ts`, `services/pages/delete.ts`,
 * `services/workflows/delete.ts`), and
 * `services/pins/list.ts` sweeps whatever a path we do not own left behind
 * (an FK cascade, a manual DELETE) before rendering. A target that merely
 * became invisible — a disabled collection, a page the requester may not see —
 * is dropped from the response but NEVER deleted: re-enable the collection and
 * the pin comes back.
 */
export const userPins = pgTable(
  "user_pins",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    targetType: userPinTargetEnum("target_type").notNull(),

    /** No FK — see the table comment on how orphans are reaped instead. */
    targetId: uuid("target_id").notNull(),

    /** Dense 0…n-1 within (userId, teamId); rewritten wholesale on reorder. */
    displayOrder: integer("display_order").notNull().default(0),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    // The natural key IS the row: pinning becomes an idempotent
    // `onConflictDoNothing`, unpinning an exact-match DELETE, and the leading
    // (userId, teamId) prefix serves the sidebar read.
    primaryKey({
      name: "user_pins_pk",
      columns: [table.userId, table.teamId, table.targetType, table.targetId],
    }),
    // The cleanup sweep is `WHERE target_type = ? AND target_id = ?`, which the
    // primary key — led by `user_id` — cannot serve.
    index("user_pins_target_idx").on(table.targetType, table.targetId),
  ],
);

export type UserPin = typeof userPins.$inferSelect;
export type NewUserPin = typeof userPins.$inferInsert;
export type UserPinTarget = UserPin["targetType"];
