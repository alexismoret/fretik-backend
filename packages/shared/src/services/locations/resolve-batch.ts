import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import type { LocationValue } from "../../db/schema/field-types";
import { locations, type NewLocationRow } from "../../db/schema/locations";
import { chunkForBulk } from "../../lib/db-bulk";
import {
  geocodeLocationFieldsBatch,
  isLocationValue,
  normalizeAddressKey,
} from "../collection-records/geocode-location";

/**
 * Bulk sibling of `resolveLocationRefs` for `bulkCreate` / `bulkUpdate`: geocode
 * every un-coordinated location across `rows` with the fewest Mapbox calls
 * (reuses the batch geocoder), then upsert each UNIQUE `(team_id, address)` once
 * and replace every row's location value with its FK id. Best-effort throughout:
 * an un-resolvable value becomes a NULL FK, never a failed write.
 */
export const resolveLocationRefsBatch = async (input: {
  teamId: string;
  fieldDefs: FieldDefinition[];
  rows: Record<string, unknown>[];
}): Promise<Record<string, unknown>[]> => {
  const locationKeys = input.fieldDefs
    .filter((f) => f.type === "location")
    .map((f) => f.key);
  if (locationKeys.length === 0) return input.rows;

  // 1. Fill coordinates in bulk (dedup + cache + one v6 batch call).
  const geocoded = await geocodeLocationFieldsBatch({
    fieldDefs: input.fieldDefs,
    rows: input.rows,
  });

  // 2. Dedup the present location values by normalized address.
  const byKey = new Map<string, LocationValue>();
  geocoded.forEach((row) => {
    for (const key of locationKeys) {
      if (!(key in row)) continue;
      const value = row[key];
      if (!isLocationValue(value)) continue;
      byKey.set(normalizeAddressKey(value.address), value);
    }
  });

  // 3. Upsert every unique location, then read the ids back by key.
  const idByKey = new Map<string, number>();
  if (byKey.size > 0) {
    const upserts: NewLocationRow[] = [...byKey.entries()].map(
      ([queryKey, v]) => ({
        teamId: input.teamId,
        queryKey,
        rawAddress: v.address,
        resolvedAddress: v.address,
        geom:
          typeof v.lng === "number" && typeof v.lat === "number"
            ? [v.lng, v.lat]
            : null,
        mapboxId: v.mapboxId ?? null,
        featureType: v.featureType ?? null,
        bbox: v.bbox ?? null,
      }),
    );
    try {
      for (const chunk of chunkForBulk(upserts)) {
        await db
          .insert(locations)
          .values(chunk)
          .onConflictDoUpdate({
            target: [locations.teamId, locations.queryKey],
            // Each row upserts its own incoming values (`excluded.*`).
            set: {
              resolvedAddress: sql`excluded.resolved_address`,
              geom: sql`excluded.geom`,
              mapboxId: sql`excluded.mapbox_id`,
              featureType: sql`excluded.feature_type`,
              bbox: sql`excluded.bbox`,
              updatedAt: new Date(),
            },
          });
      }
      for (const chunk of chunkForBulk([...byKey.keys()])) {
        const found = await db
          .select({ id: locations.id, queryKey: locations.queryKey })
          .from(locations)
          .where(
            and(
              eq(locations.teamId, input.teamId),
              inArray(locations.queryKey, chunk),
            ),
          );
        for (const r of found) idByKey.set(r.queryKey, r.id);
      }
    } catch {
      // best-effort — un-mapped keys fall through to a NULL FK below.
    }
  }

  // 4. Replace each row's location value with its FK id.
  return geocoded.map((row) => {
    let out: Record<string, unknown> | null = null;
    for (const key of locationKeys) {
      if (!(key in row)) continue;
      out = out ?? { ...row };
      const value = row[key];
      out[key] = isLocationValue(value)
        ? (idByKey.get(normalizeAddressKey(value.address)) ?? null)
        : null;
    }
    return out ?? row;
  });
};
