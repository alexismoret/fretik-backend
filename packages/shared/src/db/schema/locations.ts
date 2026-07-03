import {
  bigserial,
  geometry,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { LocationBbox } from "./field-types";

/**
 * Per-team store for `location` field values — the geospatial plane of the
 * objects system. A typed table's `location` column holds a `bigint` FK into
 * this table; reads LEFT JOIN it, and the map view / spatial filters query its
 * PostGIS `geom` (a native `geometry(point,4326)`, GIST-indexed).
 *
 * Per-team (not global) on purpose: a `team_id` + RLS lets the AI (SQL tool,
 * Python SDK, tools) query it as freely as any typed table while each team sees
 * only its own rows. Cross-team dedup of the EXPENSIVE Mapbox call stays the job
 * of the separate global `mapbox_geocode_cache` — so duplicating a place per
 * team costs zero extra geocode requests.
 *
 * One row per `(team_id, query_key)` where `query_key` is the normalized address
 * (see `normalizeAddressKey`). `geom` is NULL for a resolved-but-un-geocodable
 * place — the record still references it. `lat`/`lng` for the API are derived
 * from `geom` on read (`ST_X`/`ST_Y`); `geom` is the single source of truth.
 *
 * Note: `CREATE EXTENSION postgis` and the RLS policy/GRANT are hand-authored in
 * the migration (Drizzle can't express them); the table, `geom` column and GIST
 * index come from Drizzle.
 */
export const locations = pgTable(
  "locations",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Owning team — the RLS scope. */
    teamId: uuid("team_id").notNull(),
    /** Normalized address (lowercased, trimmed, whitespace-collapsed) — dedup key. */
    queryKey: varchar("query_key", { length: 512 }).notNull(),
    /** The address as entered/selected before geocoding. */
    rawAddress: text("raw_address").notNull(),
    /** Mapbox `full_address` when resolved; falls back to `rawAddress`. */
    resolvedAddress: text("resolved_address").notNull(),
    /** The geocoded point (lng, lat); NULL when un-geocodable. GIST-indexed. */
    geom: geometry("geom", { type: "point", mode: "tuple", srid: 4326 }),
    /** Mapbox feature id of the resolved place; NULL when un-geocoded. */
    mapboxId: varchar("mapbox_id", { length: 255 }),
    /** Mapbox `feature_type` (country/region/place/address/poi/…), for the UI icon. */
    featureType: text("feature_type"),
    /** `[minLon, minLat, maxLon, maxLat]` for area features; NULL for a point. */
    bbox: jsonb("bbox").$type<LocationBbox | null>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("ux_locations_team_key").on(t.teamId, t.queryKey),
    index("ix_locations_geom").using("gist", t.geom),
  ],
);

export type LocationRow = typeof locations.$inferSelect;
export type NewLocationRow = typeof locations.$inferInsert;
