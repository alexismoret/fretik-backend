import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { AccessLevel, AccessResourceType } from "../schemas/access";
import type { Principal } from "./principal";
import { type FlatAccessColumns, flatAccessible } from "./sql";

/**
 * Pages and workflows: the two resources that carried a privacy column before
 * the engine (`user_id`: set = private to that person, null = the team's).
 *
 * The column stays, with its meaning, because code that predates the engine
 * reads it — the containers still running during a deploy, and a rollback.
 * So both directions go through here:
 *
 *   reading   a row is restricted when EITHER column says so, and its owner
 *             falls back to `user_id`, then to its author;
 *   writing   `restrictionColumns` sets all three together, keeping
 *             `user_id = access_restricted ? owner_user_id : null`.
 */

/** The columns a legacy-privacy table has, whatever its alias. */
export interface LegacyPrivacyTable {
  readonly id: AnyColumn | SQL;
  readonly organizationId: AnyColumn | SQL;
  readonly teamId: AnyColumn | SQL;
  readonly projectId: AnyColumn | SQL;
  readonly ownerUserId: AnyColumn | SQL;
  readonly userId: AnyColumn | SQL;
  readonly createdByUserId: AnyColumn | SQL;
  readonly accessRestricted: AnyColumn | SQL;
}

/**
 * The same columns under a table alias of a hand-written query
 * (`FROM workflows w`). The alias is a constant of the caller's own SQL,
 * never input.
 */
export const legacyPrivacyAlias = (alias: string): LegacyPrivacyTable => {
  const column = (name: string): SQL => sql.raw(`${alias}.${name}`);
  return {
    id: column("id"),
    organizationId: column("organization_id"),
    teamId: column("team_id"),
    projectId: column("project_id"),
    ownerUserId: column("owner_user_id"),
    userId: column("user_id"),
    createdByUserId: column("created_by_user_id"),
    accessRestricted: column("access_restricted"),
  };
};

export const legacyPrivacyColumns = (
  table: LegacyPrivacyTable,
): FlatAccessColumns => ({
  id: table.id,
  organizationId: table.organizationId,
  teamId: table.teamId,
  projectId: table.projectId,
  owner: sql`COALESCE(${table.ownerUserId}, ${table.userId}, ${table.createdByUserId})`,
  restricted: sql`(${table.accessRestricted} OR ${table.userId} IS NOT NULL)`,
});

/**
 * The rows the principal reaches at `level`, as a relational-query filter to
 * spread into a `where`. A system principal is not filtered — it is the
 * caller's explicit, reviewed decision to act for nobody in particular.
 */
export const legacyPrivacyWhere = (input: {
  principal: Principal;
  level: AccessLevel;
  resourceType: Extract<AccessResourceType, "page" | "workflow">;
  /** The workflow rule: a restricted workflow is capped at `view` for others. */
  restrictedCeiling?: AccessLevel;
}): Record<string, never> | { RAW: (table: LegacyPrivacyTable) => SQL } => {
  const { principal } = input;
  if (principal.kind === "system") return {};
  return {
    RAW: (table) =>
      flatAccessible({
        principal,
        level: input.level,
        resourceType: input.resourceType,
        columns: legacyPrivacyColumns(table),
        restrictedCeiling: input.restrictedCeiling,
      }),
  };
};

/**
 * The columns to write when a row's restriction or owner is set — the only
 * way this code writes them, so the legacy column never disagrees.
 */
export const restrictionColumns = (input: {
  restricted: boolean;
  ownerUserId: string | null;
}): {
  accessRestricted: boolean;
  ownerUserId: string | null;
  userId: string | null;
} => ({
  accessRestricted: input.restricted,
  ownerUserId: input.ownerUserId,
  // A restricted row with no owner (its owner's account is gone) stays
  // restricted through `access_restricted`; the legacy column cannot express
  // "private to nobody", and null would read as "the team's".
  userId: input.restricted ? input.ownerUserId : null,
});
