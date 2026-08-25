import { sql } from "drizzle-orm";
import db from "../../db";
import type { LocationBbox } from "../../db/schema/field-types";
import { badRequest, throwHttpError } from "../../lib/errors";
import {
  assertSafeKey,
  qualifiedCollectionTable,
} from "../collection-schema/identifiers";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { recordVisibilityCondition, resolveRecordTypeScope } from "./scope";

/**
 * Viewport-scoped points for the Map view. Given a bounding box, it returns
 * either the individual records (with their title + coordinates) or, when too
 * many fall in view, PostGIS grid-aggregated clusters — so the client fetches
 * only what the camera shows and never megabytes of coincident points.
 *
 * One indexed query: `collection_records ⋈ data.coll_<collectionId> ⋈ locations`, filtered
 * by the same `recordVisibilityCondition` the list uses (RLS mirror, composed in
 * from the Drizzle builder) and `loc.geom && ST_MakeEnvelope(...)` on the GIST
 * index. Runs on the owner connection, so a cross-team shared record's location
 * renders too.
 *
 * Raw SQL (like `record-io`/`field-filter`): the query joins the per-type table
 * `data.coll_<collectionId>`, which is created by the DDL engine and is NOT a Drizzle
 * schema table, so the builder can't reference it or its FK column.
 */

/** Above this many records in the viewport, aggregate server-side into clusters. */
const POINT_CAP = 3000;
/** Target grid columns across the viewport width when clustering. */
const CLUSTER_GRID = 64;

export type MapBbox = {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
};

export type MapPoint = {
  id: string;
  label: string;
  lng: number;
  lat: number;
  featureType: string | null;
  bbox: LocationBbox | null;
};

export type MapCluster = { lng: number; lat: number; count: number };

export type MapPointsResult =
  | { mode: "points"; points: MapPoint[] }
  | { mode: "clusters"; clusters: MapCluster[] };

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

/** Coerce a jsonb `bbox` back to a `[minLon,minLat,maxLon,maxLat]` tuple. */
const asBbox = (v: unknown): LocationBbox | null => {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const [a, b, c, d] = v;
  return typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number"
    ? [a, b, c, d]
    : null;
};

export const getMapPoints = async (input: {
  teamId: string;
  collectionId: string;
  fieldKey: string;
  // Omitted = the whole dataset (the client's first call). Present = viewport.
  bbox?: MapBbox;
}): Promise<MapPointsResult> => {
  assertSafeKey(input.fieldKey, "location field key");

  // The field must exist on the type AND be a location field.
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: input.teamId,
    collectionId: input.collectionId,
  });
  const field = fieldDefs.find((f) => f.key === input.fieldKey);
  if (!field || field.type !== "location") {
    return throwHttpError(
      400,
      badRequest(`'${input.fieldKey}' is not a location field of this type`),
    );
  }

  const scope = await resolveRecordTypeScope({
    collectionId: input.collectionId,
    teamId: input.teamId,
  });
  const visibility = recordVisibilityCondition({ teamId: input.teamId, scope });

  const table = sql.raw(qualifiedCollectionTable(input.collectionId));
  const fkCol = sql.raw(`o."${input.fieldKey}"`);
  const bbox = input.bbox;
  // Only geocoded rows count (geom NOT NULL); bound to the viewport when given.
  const spatial = bbox
    ? sql`AND loc.geom && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`
    : sql`AND loc.geom IS NOT NULL`;

  // Shared FROM + WHERE: records of this type, visible, confirmed, whose location
  // point falls in the viewport (or anywhere, for the unbounded first call).
  const fromWhere = sql`
    FROM collection_records
    JOIN ${table} o ON o.id = collection_records.id
    JOIN public.locations loc ON loc.id = ${fkCol}
    WHERE collection_records.collection_id = ${input.collectionId}
      AND collection_records.status = 'confirmed'
      ${visibility ? sql`AND ${visibility}` : sql``}
      ${spatial}`;

  // Bounded count: we only need "≤ cap or not", so stop scanning at cap+1 rows —
  // O(cap), not O(all matching rows), so it stays fast at millions of records.
  const counted = await db.execute(
    sql`SELECT count(*)::int AS n FROM (SELECT 1 ${fromWhere} LIMIT ${POINT_CAP + 1}) s`,
  );
  const total = num(counted.rows[0]?.n ?? 0);

  if (total <= POINT_CAP) {
    const res = await db.execute(sql`
      SELECT o.id::text AS id, o._label AS label,
             ST_X(loc.geom) AS lng, ST_Y(loc.geom) AS lat,
             loc.feature_type AS feature_type, loc.bbox AS bbox
      ${fromWhere}`);
    const points: MapPoint[] = res.rows.map((r) => ({
      id: String(r.id),
      label: typeof r.label === "string" ? r.label : "",
      lng: num(r.lng),
      lat: num(r.lat),
      featureType: typeof r.feature_type === "string" ? r.feature_type : null,
      bbox: asBbox(r.bbox),
    }));
    return { mode: "points", points };
  }

  // Too many points: snap to a grid sized to the viewport (or the whole world for
  // the unbounded first call) and return one cluster per non-empty cell.
  const width = bbox ? bbox.maxLng - bbox.minLng : 360;
  const cell = Math.max(width / CLUSTER_GRID, 1e-6);
  const res = await db.execute(sql`
    SELECT ST_X(ST_Centroid(ST_Collect(loc.geom))) AS lng,
           ST_Y(ST_Centroid(ST_Collect(loc.geom))) AS lat,
           count(*)::int AS n
    ${fromWhere}
    GROUP BY ST_SnapToGrid(loc.geom, ${cell}, ${cell})`);
  const clusters: MapCluster[] = res.rows.map((r) => ({
    lng: num(r.lng),
    lat: num(r.lat),
    count: num(r.n),
  }));
  return { mode: "clusters", clusters };
};
