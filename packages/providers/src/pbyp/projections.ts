/**
 * What `query_items` asks for when the caller names no fields.
 *
 * Directus' own default is a shallow `*`: every relation comes back as a
 * bare foreign key. Measured cost of that default, 08/09: asked for a list
 * of sea bookings, the agent got `"companies": 1198`, could not tell an id
 * from a junction row, and downloaded 379 bookings plus 1 264 companies —
 * three times — to join them by hand. Nine tool calls for a question the
 * server answers in one.
 *
 * So the generic read carries the same curated projection the typed
 * searches used to keep to themselves: the columns a person actually asks
 * about, with every party, carrier and terminal resolved to its NAME in the
 * same round-trip. The agent gets a readable row on the first try and never
 * has to chase an id.
 *
 * Two boundaries:
 *  - a projection is a DEFAULT, never a cap — an explicit `fields` wins,
 *    and so does an `aggregate` (Directus refuses both at once);
 *  - a collection with no entry falls back to Directus' `*`. That is the
 *    honest outcome for the reference tables, where the row IS its columns.
 *
 * Every path here was replayed against preprod before it shipped.
 */

const PARTY = [
  "shipper.name",
  "consignee.name",
  "consignee.city",
  "consignee.country_id.name",
] as const;

const TOTALS = ["total_weight", "total_volume", "total_quantity"] as const;

const FOLDER = [
  "id",
  "folder_number",
  "folder_type",
  "shipping_status",
  "status",
  "date",
  "incoterm",
  "client_reference",
  "main_external_reference",
  "master_id.folder_number",
  "payer_id.name",
  "voyage_id.booking_number",
  "voyage_id.arrival_terminal.name",
  "pickup_date",
  "delivery_date",
  ...TOTALS,
  ...PARTY,
] as const;

const BOOKING = [
  "id",
  "booking_number",
  "booking_type",
  "shipping_status",
  "status",
  "voyage_number",
  "custom_company",
  "departure_terminal.name",
  "arrival_terminal.name",
  "ETD",
  "ETA",
  "ATD",
  "ATA",
] as const;

export const DEFAULT_PROJECTIONS: Readonly<Record<string, readonly string[]>> =
  {
    orders: [
      "id",
      "number",
      "transport_type",
      "shipping_status",
      "status",
      "date",
      "incoterm",
      "client_reference",
      "main_external_reference",
      "pickup_date",
      "delivery_date",
      ...TOTALS,
      ...PARTY,
    ],
    sea_folders: FOLDER,
    air_folders: FOLDER,
    // The carrier is the point: `companies` / `airline_company` are m2o, so
    // one dot resolves the shipping line instead of handing back an id.
    sea_bookings: [
      ...BOOKING,
      "ship_name",
      "BL_number",
      "new_ETD",
      "new_ETA",
      "companies.name",
    ],
    air_bookings: [...BOOKING, "LTA", "airline_company.name"],
    containers: [
      "id",
      "number",
      "type",
      "shipping_method",
      "shipping_status",
      "status",
      "co2",
      "sea_booking.booking_number",
    ],
    events: [
      "id",
      "code",
      "date",
      "actual",
      "source",
      "comments",
      "type.code",
      "type.description",
      "terminal.name",
      "address.name",
    ],
  };

/** The default `fields` for a collection, or `undefined` to let Directus decide. */
export const projectionFor = (collection: string): string | undefined => {
  const fields = DEFAULT_PROJECTIONS[collection];
  return fields === undefined ? undefined : fields.join(",");
};
