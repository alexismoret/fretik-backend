import { type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  documentAccessColumnsOf,
  driveVisibility,
  mirrorRecordVisible,
} from "../../authz/drive-sql";
import {
  legacyPrivacyAlias,
  legacyPrivacyColumns,
} from "../../authz/legacy-privacy";
import type { Principal } from "../../authz/principal";
import { flatAccessible } from "../../authz/sql";
import db from "../../db";
import { documents } from "../../db/schema";
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

const EVENT_DOCUMENT = "event_document";
const eventDocument = alias(documents, EVENT_DOCUMENT);

/**
 * The Drive item an entry names is gone, and it was open to its whole team
 * when it went (`teamOpenDriveItems`): the team reads the entry.
 */
const gone = (table: SQL, id: SQL): SQL => sql`
  (de.payload->>'teamOpen')::boolean IS TRUE
  AND NOT EXISTS (SELECT 1 FROM ${table} WHERE id = (${id})::uuid)
`;

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
  /**
   * The reader. Run events of a workflow they cannot see are left out — same
   * rule as the "needs attention" card — and so are run events of a workflow
   * that no longer exists, whose audience can no longer be known.
   *
   * The Drive follows the same rule: an event about a file or a folder shows
   * to those who can open it (a record's, to those who can see the record).
   * Once the file or folder is gone, it shows to the team if the whole team
   * could open it then, and to no one otherwise — its name was its
   * audience's.
   */
  principal: Principal;
  limit?: number;
}): Promise<{ items: DashboardActivityItem[] }> => {
  const { teamId, principal } = data;
  const workflowVisible =
    principal.kind === "system"
      ? sql`true`
      : flatAccessible({
          principal,
          level: "view",
          resourceType: "workflow",
          columns: legacyPrivacyColumns(legacyPrivacyAlias("w")),
          restrictedCeiling: "view",
        });
  const drive = await driveVisibility(principal, teamId);
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
      AND (
        de.payload->>'workflowId' IS NULL
        OR (w.id IS NOT NULL AND ${workflowVisible})
      )
      AND (
        de.payload->>'documentId' IS NULL
        OR EXISTS (
          SELECT 1 FROM ${documents} AS ${sql.identifier(EVENT_DOCUMENT)}
          WHERE ${eventDocument.id} = (de.payload->>'documentId')::uuid
            AND ${drive.document(documentAccessColumnsOf(eventDocument))}
        )
        OR (${gone(sql`documents`, sql`de.payload->>'documentId'`)})
      )
      AND (
        de.subject_type IS DISTINCT FROM 'folder'
        OR ${drive.folder(sql`(de.payload->>'folderId')::uuid`)}
        OR (${gone(sql`folders`, sql`de.payload->>'folderId'`)})
      )
      AND (orr.id IS NULL OR ${mirrorRecordVisible(drive, sql`orr.document_id`)})
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
