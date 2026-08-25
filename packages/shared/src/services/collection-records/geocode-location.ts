import { eq, inArray } from "drizzle-orm";
import db from "../../db";
import type { FieldDefinition } from "../../db/schema";
import {
  type LocationBbox,
  type LocationValue,
  MAPBOX_FEATURE_TYPES,
  type MapboxFeatureType,
} from "../../db/schema/field-types";
import {
  mapboxGeocodeCache,
  type NewMapboxGeocodeCacheRow,
} from "../../db/schema/mapbox-geocode-cache";
import { chunkForBulk } from "../../lib/db-bulk";

/**
 * Server-side geocoding for `location` fields. The UI autocomplete already
 * resolves coordinates; this fills them for values written WITHOUT coords — an
 * agent/SDK/import passing a bare address string (coerced to `{ address }`).
 *
 * Best-effort by design: a missing token, a Mapbox error, or a low-confidence
 * match leaves the value at `{ address }` (no coords, no map) rather than failing
 * the record write. Uses Mapbox Geocoding v6 (forward + batch) via Bun's native
 * `fetch`, and a global `mapbox_geocode_cache` so an address is only sent to
 * Mapbox once, ever.
 */

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

/** Max queries per Mapbox v6 batch request. */
const MAPBOX_BATCH_LIMIT = 1000;

/**
 * Only store a match Mapbox is confident about. v6 returns a numeric
 * `relevance` (0–1) per feature; require a strong match so a fuzzy guess is
 * never stored. When `relevance` is absent (e.g. reverse), fall back to
 * `properties.match_code.confidence` ∈ {exact, high, medium, low} — accept
 * exact/high. When neither is present there is nothing to gate on → accept.
 */
const RELEVANCE_THRESHOLD = 0.8;
const ACCEPTED_CONFIDENCE: ReadonlySet<string> = new Set(["exact", "high"]);

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const str = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;
const numAt = (arr: unknown, i: number): number | undefined =>
  Array.isArray(arr) && typeof arr[i] === "number" ? arr[i] : undefined;

export const isLocationValue = (v: unknown): v is LocationValue =>
  isRec(v) && typeof v.address === "string";

const asFeatureType = (v: unknown): MapboxFeatureType | undefined =>
  typeof v === "string" ? MAPBOX_FEATURE_TYPES.find((t) => t === v) : undefined;

/** A `[minLon, minLat, maxLon, maxLat]` tuple, or undefined for a point feature. */
const asBbox = (v: unknown): LocationBbox | undefined => {
  if (!Array.isArray(v) || v.length !== 4) return undefined;
  const arr: unknown[] = v;
  const [a, b, c, d] = arr;
  return typeof a === "number" &&
    typeof b === "number" &&
    typeof c === "number" &&
    typeof d === "number"
    ? [a, b, c, d]
    : undefined;
};

/** Whether the match is trustworthy enough to store (see RELEVANCE_THRESHOLD). */
const isTrustworthy = (
  feat: Record<string, unknown>,
  props: Record<string, unknown>,
): boolean => {
  if (typeof feat.relevance === "number")
    return feat.relevance >= RELEVANCE_THRESHOLD;
  const mc = isRec(props.match_code) ? props.match_code : undefined;
  const confidence = mc ? str(mc.confidence) : undefined;
  return confidence === undefined || ACCEPTED_CONFIDENCE.has(confidence);
};

/**
 * Normalize an address into a deterministic cache key — lowercased, trimmed,
 * whitespace-collapsed. No locale (that would fragment the cache; coordinates
 * are language-independent).
 */
export const normalizeAddressKey = (address: string): string =>
  address.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Map one Mapbox v6 feature to a `LocationValue` partial. Returns null when the
 * feature is absent or its match confidence is too low to trust.
 */
const parseFeature = (
  feat: unknown,
  address: string,
): Partial<LocationValue> | null => {
  if (!isRec(feat)) return null;
  const props = isRec(feat.properties) ? feat.properties : {};
  if (!isTrustworthy(feat, props)) return null;
  const geom = isRec(feat.geometry) ? feat.geometry : {};
  return {
    address: str(props.full_address) ?? address,
    lat: numAt(geom.coordinates, 1),
    lng: numAt(geom.coordinates, 0),
    mapboxId: str(props.mapbox_id),
    featureType: asFeatureType(props.feature_type),
    // v6 puts the bbox on the GeoJSON feature; some responses mirror it in props.
    bbox: asBbox(feat.bbox ?? props.bbox),
  };
};

/** Forward-geocode one address; null on any failure (caller keeps the address). */
const geocodeAddress = async (
  address: string,
): Promise<Partial<LocationValue> | null> => {
  if (!MAPBOX_TOKEN) return null;
  try {
    const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(
      address,
    )}&limit=1&access_token=${MAPBOX_TOKEN}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const features =
      isRec(json) && Array.isArray(json.features) ? json.features : [];
    return parseFeature(features[0], address);
  } catch {
    return null;
  }
};

/**
 * Forward-geocode up to 1000 addresses in one Mapbox v6 batch request. Returns
 * results index-aligned to `addresses` (null per un-resolved / low-confidence
 * entry). The batch response envelope is `{ batch: [FeatureCollection, …] }`.
 */
const geocodeBatch = async (
  addresses: string[],
): Promise<(Partial<LocationValue> | null)[]> => {
  if (!MAPBOX_TOKEN || addresses.length === 0) return addresses.map(() => null);
  try {
    const url = `https://api.mapbox.com/search/geocode/v6/batch?access_token=${MAPBOX_TOKEN}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addresses.map((q) => ({ q, limit: 1 }))),
    });
    if (!res.ok) return addresses.map(() => null);
    const json: unknown = await res.json();
    const batch: unknown[] =
      isRec(json) && Array.isArray(json.batch) ? json.batch : [];
    return addresses.map((address, i) => {
      const entry = batch[i];
      const features: unknown[] =
        isRec(entry) && Array.isArray(entry.features) ? entry.features : [];
      return parseFeature(features[0], address);
    });
  } catch {
    return addresses.map(() => null);
  }
};

/** Best-effort multi-row cache write, chunked under the bound-param ceiling. */
const writeCache = async (rows: NewMapboxGeocodeCacheRow[]): Promise<void> => {
  for (const chunk of chunkForBulk(rows)) {
    try {
      await db.insert(mapboxGeocodeCache).values(chunk).onConflictDoNothing();
    } catch {
      // cache write is best-effort.
    }
  }
};

/**
 * Geocode one address through the cache: return a hit (including a negative-cache
 * `null`), else geocode live and write the result back. Cache read/write are
 * best-effort — a DB error falls through to a live fetch.
 */
export const geocodeAddressCached = async (
  address: string,
): Promise<Partial<LocationValue> | null> => {
  const key = normalizeAddressKey(address);
  try {
    const hit = await db
      .select({ result: mapboxGeocodeCache.result })
      .from(mapboxGeocodeCache)
      .where(eq(mapboxGeocodeCache.queryKey, key))
      .limit(1);
    if (hit.length > 0) return hit[0]!.result;
  } catch {
    // cache read failed — fall through to a live geocode.
  }
  const geo = await geocodeAddress(address);
  await writeCache([
    { queryKey: key, mapboxId: geo?.mapboxId ?? null, result: geo },
  ]);
  return geo;
};

/**
 * Batch variant for bulk create/update: geocode every un-coordinated `location`
 * value across `rows` with the fewest possible Mapbox calls — dedup identical
 * addresses, serve from the cache, and send only the misses through the v6 batch
 * endpoint (chunked ≤1000). Runs entirely OUTSIDE any DB transaction. Best-effort
 * per row: an un-resolved address keeps `{ address }` and never fails the insert.
 * Returns a rows array with geocoded values merged in (index-aligned to input).
 */
export const geocodeLocationFieldsBatch = async (input: {
  fieldDefs: FieldDefinition[];
  rows: Record<string, unknown>[];
}): Promise<Record<string, unknown>[]> => {
  const locationKeys = input.fieldDefs
    .filter((f) => f.type === "location")
    .map((f) => f.key);
  if (locationKeys.length === 0) return input.rows;

  // 1. Collect the location values that still need geocoding.
  const targets: { rowIndex: number; key: string; norm: string }[] = [];
  const addressByKey = new Map<string, string>();
  input.rows.forEach((row, rowIndex) => {
    for (const key of locationKeys) {
      const value = row[key];
      if (!isLocationValue(value)) continue;
      if (typeof value.lat === "number" && typeof value.lng === "number")
        continue;
      const norm = normalizeAddressKey(value.address);
      targets.push({ rowIndex, key, norm });
      if (!addressByKey.has(norm)) addressByKey.set(norm, value.address);
    }
  });
  if (targets.length === 0) return input.rows;

  const uniqueKeys = [...addressByKey.keys()];
  const resolved = new Map<string, Partial<LocationValue> | null>();

  // 2. Cache read for the unique addresses.
  try {
    const hits = await db
      .select({
        queryKey: mapboxGeocodeCache.queryKey,
        result: mapboxGeocodeCache.result,
      })
      .from(mapboxGeocodeCache)
      .where(inArray(mapboxGeocodeCache.queryKey, uniqueKeys));
    for (const h of hits) resolved.set(h.queryKey, h.result);
  } catch {
    // cache read failed — treat everything as a miss and geocode live.
  }

  // 3. Misses → v6 batch (chunked ≤1000), then write back to the cache.
  const misses = uniqueKeys.filter((k) => !resolved.has(k));
  for (let i = 0; i < misses.length; i += MAPBOX_BATCH_LIMIT) {
    const chunk = misses.slice(i, i + MAPBOX_BATCH_LIMIT);
    const results = await geocodeBatch(
      chunk.map((k) => addressByKey.get(k) ?? k),
    );
    const writes: NewMapboxGeocodeCacheRow[] = chunk.map((k, j) => {
      const geo = results[j] ?? null;
      resolved.set(k, geo);
      return { queryKey: k, mapboxId: geo?.mapboxId ?? null, result: geo };
    });
    await writeCache(writes);
  }

  // 4. Merge resolved coords back into each row (copy elements we touch).
  const out = [...input.rows];
  for (const t of targets) {
    const geo = resolved.get(t.norm);
    if (!geo) continue;
    const value = out[t.rowIndex]?.[t.key];
    if (!isLocationValue(value)) continue;
    out[t.rowIndex] = { ...out[t.rowIndex], [t.key]: { ...value, ...geo } };
  }
  return out;
};
