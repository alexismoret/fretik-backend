import { sql } from "drizzle-orm";
import db from "../../db";
import type { DashboardActivityItem } from "../../schemas/dashboard";

const DEFAULT_LIMIT = 10;

/**
 * The journal event types worth showing on the home "Recent activity" feed —
 * things that happened to the team's content, catalog, files, apps and skills.
 * Excludes the chattiest plumbing (`chat.turn`, `episode.*`, `memory.*`,
 * `link.*` — no meaningful title). The `*.` prefixes catch runtime families:
 * `connector.*` provider activity and `workflow.*` / `trigger.*` run lifecycle.
 */
const DISPLAY_EVENT_TYPES = [
  "document.uploaded",
  "document.revised",
  "document.deleted",
  "document.reextracted",
  "record.created",
  "record.updated",
  "record.confirmed",
  "record.rejected",
  "record.deleted",
  "collection.created",
  "collection.updated",
  "collection.deleted",
  "folder.created",
  "folder.renamed",
  "folder.deleted",
  "skill.created",
  "skill.updated",
  "skill.deleted",
] as const;

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The home "Recent activity" feed, read straight from the durable journal
 * (`domain_events`) — the single append-only source every mutation writes to.
 * Each event is enriched in one query so a row is genuinely useful: the subject
 * record's label (or the workflow's name for run events, or a payload name for
 * subject-less events) as the title, the acting user, the run outcome, and the
 * ids the frontend needs to make the row click through to its target. Ordered
 * by the v7 id (time-ordered), newest first.
 */
export const getDashboardActivity = async (data: {
  teamId: string;
  limit?: number;
}): Promise<{ items: DashboardActivityItem[] }> => {
  const { teamId } = data;
  const limit = data.limit ?? DEFAULT_LIMIT;
  const typeList = sql.join(
    DISPLAY_EVENT_TYPES.map((type) => sql`${type}`),
    sql`, `,
  );

  const result = await db.execute(sql`
    SELECT
      de.id::text AS id,
      de.type AS type,
      de.occurred_at AS at,
      COALESCE(
        orr.label,
        w.name,
        de.payload->>'title',
        de.payload->>'name',
        de.payload->>'label',
        de.payload->>'displayName',
        de.payload->>'providerKey',
        ''
      ) AS title,
      u.name AS actor_name,
      de.payload->>'status' AS status,
      orr.document_id::text AS document_id,
      ot.key AS collection_key,
      de.payload->>'workflowId' AS workflow_id,
      de.payload->>'runId' AS run_id
    FROM domain_events de
    LEFT JOIN collection_records orr ON orr.id = de.subject_record_id
    LEFT JOIN collections ot ON ot.id = orr.collection_id
    LEFT JOIN workflows w ON w.id = (de.payload->>'workflowId')::uuid
    LEFT JOIN "user" u ON u.id = de.actor_user_id
    WHERE de.team_id = ${teamId}
      AND (
        de.type IN (${typeList})
        OR de.type LIKE 'connector.%'
        OR de.type LIKE 'workflow.%'
        OR de.type LIKE 'trigger.%'
      )
    ORDER BY de.id DESC
    LIMIT ${limit}
  `);

  const items = result.rows.map((row): DashboardActivityItem => {
    const at = row.at;
    return {
      id: String(row.id),
      type: String(row.type),
      title: typeof row.title === "string" ? row.title : "",
      actorName: asString(row.actor_name),
      status: asString(row.status),
      documentId: asString(row.document_id),
      collectionKey: asString(row.collection_key),
      workflowId: asString(row.workflow_id),
      runId: asString(row.run_id),
      at: at instanceof Date ? at : new Date(String(at)),
    };
  });

  return { items };
};
