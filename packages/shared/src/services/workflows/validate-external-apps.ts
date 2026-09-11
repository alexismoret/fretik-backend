import db from "../../db";
import { badRequest, throwHttpError } from "../../lib/errors";

/**
 * Vet the external-app connections a workflow declares.
 *
 * TWO different questions are asked here, of two different identities, and
 * collapsing them is what makes the refusal useless:
 *
 *  1. **Can the AUTHOR name this connection at all?** Answered against the
 *     actor, with the same predicate as `getConnectionForCaller`: team-shared,
 *     or personal to them. A teammate's personal connection is not found, so
 *     it is refused as unknown and its display name never leaks.
 *
 *  2. **Can the WORKFLOW use it?** Answered against `workflow.userId ?? the
 *     team bot` — the identity a run acts as, and the only one
 *     `resolveConnection` will resolve a connection for. A TEAM workflow can
 *     therefore never reach a personal connection: declaring one promises an
 *     app the run cannot open, and the failure would surface much later as
 *     `EXTERNAL_APP_NO_CONNECTION` inside a cron run nobody is watching.
 *
 * Asking only the second question — which this did until CI caught it — makes
 * the interesting branch unreachable: a personal connection is already outside
 * a team workflow's visibility, so it falls out as "unknown id 01a08dfb-…"
 * instead of "cannot use a personal connection (My mailbox); make the workflow
 * private, or share the app". Same refusal, none of the information that makes
 * it actionable.
 *
 * Returns the ids, de-duplicated and in the order given. An empty list means
 * "nothing declared" and is always valid.
 */
export const validateWorkflowExternalApps = async (params: {
  connectionIds: string[];
  teamId: string;
  /** The workflow's owner: null = team-shared (runs as the team bot). */
  ownerUserId: string | null;
  /**
   * Who is writing. Bounds which connections can be NAMED, so an author never
   * learns the display name of a teammate's personal connection. Absent =
   * system trust (internal callers), which sees the whole team — the same
   * convention as `workflowVisibilityWhere`.
   */
  actorUserId?: string;
}): Promise<string[]> => {
  const ids = [...new Set(params.connectionIds)];
  if (ids.length === 0) return ids;

  const rows = await db.query.externalAppConnections.findMany({
    columns: { id: true, userId: true, displayName: true },
    where: {
      id: { in: ids },
      teamId: params.teamId,
      ...(params.actorUserId !== undefined
        ? {
            OR: [{ userId: { isNull: true } }, { userId: params.actorUserId }],
          }
        : {}),
    },
  });

  const found = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return throwHttpError(
      400,
      badRequest(
        `Unknown external-app connection(s) for this workflow: ${missing.join(", ")}. You can only use connections shared with the team, or your own personal ones.`,
      ),
    );
  }

  // Now the workflow's own identity: a connection it could not resolve at run
  // time has no business being declared on it.
  const unreachable = rows.filter(
    (row) => row.userId !== null && row.userId !== params.ownerUserId,
  );
  if (unreachable.length > 0) {
    const names = unreachable.map((row) => row.displayName).join(", ");
    return throwHttpError(
      400,
      badRequest(
        params.ownerUserId === null
          ? `A team workflow runs as the team assistant and cannot use a personal connection (${names}). Make the workflow private, or share the connection with the team.`
          : `This workflow runs as its owner, who cannot use ${names} — it is personal to someone else. Share that connection with the team to use it here.`,
      ),
    );
  }

  return ids;
};
