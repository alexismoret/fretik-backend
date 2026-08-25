import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import type { LocationValue } from "../../db/schema/field-types";
import { locations } from "../../db/schema/locations";
import {
  geocodeAddressCached,
  isLocationValue,
  normalizeAddressKey,
} from "../collection-records/geocode-location";

/**
 * Resolve the `location` field values in a record's `data` to FK ids into the
 * per-team `locations` table — the write-side counterpart of the read-side
 * LEFT JOIN in `dataJsonbExpr`. For each location value it fills coordinates
 * (best-effort, via the global geocode cache), upserts the team's `locations`
 * row keyed by `(team_id, normalized address)`, and replaces the value with that
 * row's `id` (a bigint). A null / un-resolvable value becomes a NULL FK.
 *
 * Only keys PRESENT in `data` are touched (so it is patch-safe for updates); a
 * type with no location field is a no-op. Runs BEFORE the record write's
 * transaction (mirrors the geocoding it replaces): it makes an HTTP geocode call
 * so it must not sit inside a DB transaction, and the `locations` upsert is an
 * idempotent, dedup'd write with no hard FK — an orphan row from a rolled-back
 * record write is harmless and is reused on the next reference.
 */

/** Upsert one team location row from a (possibly un-geocoded) value → its id. */
const upsertLocation = async (
  teamId: string,
  value: LocationValue,
): Promise<number | null> => {
  let v = value;
  if (typeof v.lat !== "number" || typeof v.lng !== "number") {
    const geo = await geocodeAddressCached(v.address);
    if (geo) v = { ...v, ...geo };
  }
  const queryKey = normalizeAddressKey(value.address);
  // The PostGIS point (lng, lat); NULL when the address didn't geocode.
  const geom: [number, number] | null =
    typeof v.lng === "number" && typeof v.lat === "number"
      ? [v.lng, v.lat]
      : null;
  try {
    const [row] = await db
      .insert(locations)
      .values({
        teamId,
        queryKey,
        rawAddress: value.address,
        resolvedAddress: v.address,
        geom,
        mapboxId: v.mapboxId ?? null,
        featureType: v.featureType ?? null,
        bbox: v.bbox ?? null,
      })
      .onConflictDoUpdate({
        target: [locations.teamId, locations.queryKey],
        set: {
          resolvedAddress: v.address,
          geom,
          mapboxId: v.mapboxId ?? null,
          featureType: v.featureType ?? null,
          bbox: v.bbox ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: locations.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
};

export const resolveLocationRefs = async (input: {
  teamId: string;
  fieldDefs: FieldDefinition[];
  data: Record<string, unknown>;
}): Promise<Record<string, unknown>> => {
  const locationKeys = input.fieldDefs
    .filter((f) => f.type === "location")
    .map((f) => f.key);
  if (locationKeys.length === 0) return input.data;

  let out: Record<string, unknown> | null = null;
  for (const key of locationKeys) {
    if (!(key in input.data)) continue;
    out = out ?? { ...input.data };
    const value = input.data[key];
    out[key] = isLocationValue(value)
      ? await upsertLocation(input.teamId, value)
      : null;
  }
  return out ?? input.data;
};
