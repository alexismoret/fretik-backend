import { jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
import type { LocationValue } from "./field-types";

/**
 * Global (org-agnostic) geocode cache: a normalized address → its geocoded
 * result (coords, bbox, mapboxId, featureType). Populated best-effort by the
 * server-side geocoder (single + bulk paths) so the SAME address is only sent to
 * Mapbox once, ever — the win that keeps a 1000-record bulk insert cheap.
 *
 * Why org-agnostic (no organizationId): a row is a pure `address → coordinates`
 * mapping — public geographic data, no tenant content or PII beyond the address
 * string itself, and a hit requires already possessing that address. So there is
 * no cross-tenant leak, and a global table maximises the dedup hit-rate.
 *
 * `result` NULL is a NEGATIVE cache entry: an address Mapbox couldn't resolve.
 * Kept so a re-import of the same un-geocodable string doesn't re-hammer the API.
 *
 * Append-only: no TTL / no invalidation (address→coordinate is effectively
 * immutable). A future TTL can filter on `createdAt` without a schema change.
 */
export const mapboxGeocodeCache = pgTable("mapbox_geocode_cache", {
  /**
   * Normalized address (lowercased, trimmed, whitespace-collapsed) — the dedup
   * key. Capped at 512: Mapbox's forward `q` tops out well under this.
   */
  queryKey: varchar("query_key", { length: 512 }).primaryKey(),
  /** Mapbox feature id of the resolved place; NULL for a negative-cache entry. */
  mapboxId: varchar("mapbox_id", { length: 255 }),
  /** The geocoded partial (coords + bbox + featureType); NULL = un-geocodable. */
  result: jsonb("result").$type<Partial<LocationValue> | null>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type MapboxGeocodeCacheRow = typeof mapboxGeocodeCache.$inferSelect;
export type NewMapboxGeocodeCacheRow = typeof mapboxGeocodeCache.$inferInsert;
