import type { Executor } from "../db";
import db from "../db";
import { hiddenFolderIds, teamPrivateFolderIds } from "./drive-sql";
import type { UserPrincipal } from "./principal";
import { projectsReaching, teamsReaching } from "./sql";

/**
 * What the agent's SQL tool knows of the person it reads for, as the session
 * settings its row-level security reads (migration `sql_tool_drive_scope`).
 * The same facts as `drive-sql.ts`'s predicates, flattened into lists a
 * policy can test a row against:
 *
 *   reach          the grant principals that give them `view` — themselves,
 *                  their teams and projects, their organization unless they
 *                  are a guest (`sql.ts`, `grantPrincipalMatch` at `view`);
 *   containers     the teams and projects whose content they view;
 *   hiddenFolders  the team's folders they cannot open;
 *   privateFolders the organization's folders not open to their whole team.
 *
 * Both folder lists are short because restrictions are rare; the long list —
 * everything they CAN open — never travels.
 */
export interface SqlToolDriveScope {
  readonly userId: string;
  readonly reach: readonly string[];
  readonly containers: readonly string[];
  readonly hiddenFolders: readonly string[];
  readonly privateFolders: readonly string[];
}

export const sqlToolDriveScope = async (
  principal: UserPrincipal,
  teamId: string,
  executor: Executor = db,
): Promise<SqlToolDriveScope> => {
  const [hiddenFolders, privateFolders] = await Promise.all([
    hiddenFolderIds(principal, teamId, executor),
    teamPrivateFolderIds(principal.organizationId, executor),
  ]);
  return {
    userId: principal.userId,
    reach: [
      principal.userId,
      ...principal.teamRoles.keys(),
      ...principal.projectLevels.keys(),
      ...(principal.isGuest ? [] : [principal.organizationId]),
    ],
    containers: [
      ...teamsReaching(principal, "view"),
      ...projectsReaching(principal, "view"),
    ],
    hiddenFolders,
    privateFolders,
  };
};

/** A Postgres array literal of uuids, for `set_config`. */
const uuidArrayLiteral = (ids: readonly string[]): string =>
  `{${ids.join(",")}}`;

/**
 * The one statement that scopes a SQL tool transaction: the team, the
 * organization and the person's Drive, each transaction-local
 * (`is_local => true`, the bind-safe `SET LOCAL`), so it never leaks across a
 * pooled connection. `runReadonlyQuery` runs it first; the RLS suite runs the
 * same text.
 */
export const sqlToolScopeStatement = (input: {
  teamId: string;
  organizationId: string;
  drive: SqlToolDriveScope;
}): { text: string; values: string[] } => ({
  text: `SELECT set_config('fretik.team_id', $1, true),
                set_config('fretik.organization_id', $2, true),
                set_config('fretik.user_id', $3, true),
                set_config('fretik.reach', $4, true),
                set_config('fretik.containers', $5, true),
                set_config('fretik.hidden_folders', $6, true),
                set_config('fretik.private_folders', $7, true)`,
  values: [
    input.teamId,
    input.organizationId,
    input.drive.userId,
    uuidArrayLiteral(input.drive.reach),
    uuidArrayLiteral(input.drive.containers),
    uuidArrayLiteral(input.drive.hiddenFolders),
    uuidArrayLiteral(input.drive.privateFolders),
  ],
});
