import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/**
 * Where each person last worked: the organization their session had open,
 * and its team (none for a guest's access, or a member in no team yet). A
 * new session opens there (`lib/auth-workspace.ts`), so someone who belongs
 * to several organizations or teams does not pick again at every sign-in.
 *
 * Sessions live in Redis alone and end; this row is what outlives them. It
 * is a preference, never a permission: it is checked against today's
 * memberships before a session opens on it, it is forgotten when the person
 * leaves the organization, and a deleted organization or team takes it (or
 * its team) with it.
 */
export const lastWorkspaces = pgTable(
  "last_workspaces",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => team.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // Deleting an organization or a team reaches its rows without a scan.
  (t) => [
    index("last_workspaces_organization_idx").on(t.organizationId),
    index("last_workspaces_team_idx").on(t.teamId),
  ],
);
