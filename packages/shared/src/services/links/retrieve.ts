import { sql } from "drizzle-orm";
import db from "../../db";

/**
 * Node reachable from a set of seed records, walking active edges in both
 * directions up to a bounded depth.
 */
export type NeighborhoodNode = {
  id: string;
  collectionId: string;
  label: string;
  status: string;
  depth: number;
};

export type NeighborhoodEdge = {
  id: string;
  linkTypeId: string;
  fromRecordId: string;
  toRecordId: string;
};

/**
 * Walk the graph outward from `seedRecordIds`, following ACTIVE edges
 * (`valid_to IS NULL AND invalidated_at IS NULL`) in both directions, bounded
 * by `depth` (clamped to 3) and a node/edge row `limit`. Scoped by `team_id`.
 *
 * Uses a recursive CTE: `reachable` accumulates `(record_id, depth)` from the
 * seeds; the outer query then materializes the reached records and every
 * active edge whose both endpoints are reachable. The traversal is breadth-
 * first via the depth column and capped so a dense hub cannot fan out without
 * bound.
 *
 * Every value is bound as a query parameter (drizzle's `sql` template emits
 * `$n` placeholders, never inlined text) — the array seeds use `sql.param` so
 * the whole list is a single typed `uuid[]` parameter. No string interpolation
 * of caller input into the SQL, so the raw CTE is injection-safe.
 */
export const getNeighborhood = async (data: {
  teamId: string;
  seedRecordIds: string[];
  depth: number;
  limit?: number;
}): Promise<{ nodes: NeighborhoodNode[]; edges: NeighborhoodEdge[] }> => {
  const { teamId, seedRecordIds } = data;
  const depth = Math.min(Math.max(0, data.depth), 3);
  const limit = data.limit ?? 500;

  if (seedRecordIds.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodesResult = await db.execute<NeighborhoodNode>(sql`
    WITH RECURSIVE reachable AS (
      SELECT r.id AS record_id, 0 AS depth
      FROM collection_records r
      WHERE r.team_id = ${teamId}
        AND r.id = ANY(${sql.param(seedRecordIds)}::uuid[])

      UNION

      SELECT step.next_id AS record_id, rch.depth + 1 AS depth
      FROM reachable rch
      JOIN LATERAL (
        SELECT
          CASE WHEN l.from_record_id = rch.record_id
               THEN l.to_record_id ELSE l.from_record_id END AS next_id
        FROM links l
        WHERE l.team_id = ${teamId}
          AND l.valid_to IS NULL
          AND l.invalidated_at IS NULL
          AND (l.from_record_id = rch.record_id OR l.to_record_id = rch.record_id)
      ) step ON TRUE
      WHERE rch.depth < ${depth}
    )
    SELECT r.id, r.collection_id AS "collectionId", r.label, r.status,
           MIN(rch.depth)::int AS depth
    FROM reachable rch
    JOIN collection_records r ON r.id = rch.record_id
    GROUP BY r.id, r.collection_id, r.label, r.status
    ORDER BY depth ASC
    LIMIT ${limit}
  `);

  const nodes = nodesResult.rows;
  if (nodes.length === 0) {
    return { nodes: [], edges: [] };
  }

  const nodeIds = nodes.map((n) => n.id);
  const edgesResult = await db.execute<NeighborhoodEdge>(sql`
    SELECT l.id, l.link_type_id AS "linkTypeId",
           l.from_record_id AS "fromRecordId", l.to_record_id AS "toRecordId"
    FROM links l
    WHERE l.team_id = ${teamId}
      AND l.valid_to IS NULL
      AND l.invalidated_at IS NULL
      AND l.from_record_id = ANY(${sql.param(nodeIds)}::uuid[])
      AND l.to_record_id = ANY(${sql.param(nodeIds)}::uuid[])
    LIMIT ${limit}
  `);

  return { nodes, edges: edgesResult.rows };
};

/**
 * List the active edges touching a record (either direction), with the link
 * type and the record on the other end of each edge.
 */
export const listLinksForRecord = async (data: { recordId: string }) => {
  const { recordId } = data;
  const [outgoing, incoming] = await Promise.all([
    db.query.links.findMany({
      where: {
        fromRecordId: recordId,
        validTo: { isNull: true },
        invalidatedAt: { isNull: true },
      },
      with: { linkType: true, toRecord: true },
    }),
    db.query.links.findMany({
      where: {
        toRecordId: recordId,
        validTo: { isNull: true },
        invalidatedAt: { isNull: true },
      },
      with: { linkType: true, fromRecord: true },
    }),
  ]);
  return { outgoing, incoming };
};
