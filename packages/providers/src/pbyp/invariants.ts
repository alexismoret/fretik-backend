import { isRecord } from "@fretik/shared/external-apps/json-access";
import { PBYP_SCHEMA } from "./directus-schema";
import type { PbypRelationShape } from "./schema-types";

/**
 * Pure rules shared by the Pbyp mappers and pinned by the tests.
 *
 * Everything here answers the same question: what would Pbyp reject, or
 * worse ACCEPT and quietly get wrong, if we forwarded the agent's payload
 * as written? A rule lives here — not in prose — when the failure is silent
 * or expensive: a computed column overwritten with a stale value, a
 * many-to-many list written as bare ids (Directus reads those as JUNCTION
 * row ids and re-links the wrong rows), a gateway's static token echoed
 * back into a transcript.
 *
 * The schema-derived half comes from `directus-schema.ts`; the hand-written
 * half comes from reading the Directus bundle's hooks, which compute fields
 * the schema itself has no way to flag.
 */

// ── Collection whitelists ─────────────────────────────────────────────
//
// Measured, not guessed: these are the collections the six Pbyp Access
// Policies actually grant, intersected with the schema snapshot. Sending a
// write Pbyp will refuse is a wasted round-trip and an opaque 403 in the
// transcript; refusing it here names the reason.

/** Every business collection. Which ROWS come back is the server's call. */
export const READ_COLLECTIONS: ReadonlySet<string> = new Set(
  Object.keys(PBYP_SCHEMA),
);

export const CREATE_COLLECTIONS: ReadonlySet<string> = new Set([
  "address",
  "address_book",
  "address_book_entities",
  "ai_form_configs",
  "ai_ocrs",
  "air_bookings",
  "air_bookings_events",
  "air_bookings_flights",
  "air_bookings_lta",
  "air_folders",
  "air_folders_entities",
  "air_folders_events",
  "air_folders_files",
  "air_folders_orders",
  "air_folders_parcels",
  "associated_entities",
  "booking_edi",
  "container_seals",
  "containers",
  "containers_events",
  "customers",
  "entities_alerts",
  "entities_clients",
  "event_edi",
  "events",
  "external_alerts",
  "external_event_code",
  "external_reference_address",
  "external_reference_companies",
  "external_reference_terminals",
  "external_references",
  "files",
  "files_entities",
  "folder_edi",
  "ocr_file_configs",
  "orders",
  "orders_containers",
  "orders_edi",
  "orders_entities",
  "orders_events",
  "orders_files",
  "orders_parcels",
  "parcel_types",
  "parcels",
  "parcels_adr",
  "pdf_templates",
  "profile_alert",
  "quotations",
  "quotations_containers",
  "quotations_entities",
  "quotations_orders",
  "quotations_orders_parcels",
  "quotations_parcels",
  "quotations_quotes",
  "quotations_quotes_templates",
  "quotations_quotes_templates_quotes",
  "roles",
  "roles_user_permissions",
  "sea_bookings",
  "sea_bookings_events",
  "sea_folders",
  "sea_folders_containers",
  "sea_folders_entities",
  "sea_folders_events",
  "sea_folders_files",
  "sea_folders_orders",
  "sea_folders_parcels",
  "user_table_preferences",
]);

export const UPDATE_COLLECTIONS: ReadonlySet<string> = new Set([
  ...CREATE_COLLECTIONS,
  // Update-only: the row is created elsewhere (an entity by
  // `/auth-endpoints/client`, a profile by the invite flow).
  "entities",
  "profiles",
]);

/**
 * What may be DELETED. Deliberately short, and it is the short list Pbyp
 * itself enforces: `orders`, `sea_folders`, `air_folders`, `sea_bookings`,
 * `air_bookings`, `containers` and `quotations` are absent because the
 * product cancels them by `status: "archived"` — a hook then derives
 * `shipping_status: "CANCELED"` and cascades. A DELETE would take the
 * events, the junctions and the EDI journal with it.
 */
export const DELETE_COLLECTIONS: ReadonlySet<string> = new Set([
  "address_book",
  "address_book_entities",
  "ai_form_configs",
  "air_bookings_events",
  "air_bookings_flights",
  "air_folders_entities",
  "air_folders_events",
  "air_folders_files",
  "air_folders_orders",
  "air_folders_parcels",
  "associated_entities",
  "container_seals",
  "containers_events",
  "customers",
  "entities_alerts",
  "entities_clients",
  "events",
  "external_alerts",
  "external_event_code",
  "external_reference_address",
  "external_reference_companies",
  "external_reference_terminals",
  "external_references",
  "files",
  "files_entities",
  "gateway_external",
  "ocr_file_configs",
  "orders_containers",
  "orders_entities",
  "orders_events",
  "orders_files",
  "orders_parcels",
  "parcels",
  "parcels_adr",
  "pdf_templates",
  "profile_alert",
  "profiles",
  "quotations_containers",
  "quotations_entities",
  "quotations_orders",
  "quotations_orders_parcels",
  "quotations_parcels",
  "quotations_quotes",
  "quotations_quotes_templates",
  "quotations_quotes_templates_quotes",
  "roles",
  "roles_user_permissions",
  "sea_bookings_events",
  "sea_folders_containers",
  "sea_folders_entities",
  "sea_folders_events",
  "sea_folders_files",
  "sea_folders_orders",
  "sea_folders_parcels",
  "user_table_preferences",
]);

/** Cancelled by `status: "archived"`, never by DELETE. */
export const ARCHIVABLE_COLLECTIONS: ReadonlySet<string> = new Set([
  "orders",
  "sea_folders",
  "air_folders",
  "sea_bookings",
  "air_bookings",
  "containers",
  "quotations",
]);

// ── Computed fields ───────────────────────────────────────────────────

/**
 * Present on every collection. Directus owns them; a value we send is
 * either ignored or, for `date_updated`, briefly wrong.
 */
const UNIVERSAL_COMPUTED: readonly string[] = [
  "id",
  "date_created",
  "date_updated",
  "user_created",
  "user_updated",
];

/**
 * Columns a Pbyp HOOK writes. Not derivable from the snapshot: Directus
 * `readonly` is a form hint, and it lies in both directions here —
 * `events.type` and `events.source` are flagged readonly yet REQUIRED on
 * create, while `orders.shipping_status` is writable in the schema and
 * overwritten by `shipping-status.ts` on the very next event.
 *
 * Sending one of these is not an error the API reports; it is a value that
 * survives until the hook next runs, so a reader sees a status the system
 * does not believe. They are stripped, and the caller is told which.
 */
export const COMPUTED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  orders: [
    "shipping_status",
    "main_external_reference",
    "co2",
    "total_weight",
    "total_volume",
    "total_meterage",
    "total_quantity",
    "total_taxable_weight",
  ],
  sea_folders: [
    "shipping_status",
    "folder_number",
    "main_external_reference",
    "co2",
    "total_weight",
    "total_volume",
    "total_meterage",
    "total_quantity",
    "total_taxable_weight",
  ],
  air_folders: [
    "shipping_status",
    "folder_number",
    "main_external_reference",
    "co2",
    "total_weight",
    "total_volume",
    "total_meterage",
    "total_quantity",
    "total_taxable_weight",
  ],
  sea_bookings: [
    "shipping_status",
    "co2",
    "co2_factor",
    // Derived from the events: an ATD written by hand is overwritten the
    // moment a departure event lands, and contradicts it until then.
    "ATD",
    "ATA",
    "tracking_id",
  ],
  air_bookings: [
    "shipping_status",
    "co2",
    "co2_factor",
    "ATD",
    "ATA",
    "tracking_id",
    // Recomputed from `flights` — the booking's own values are a mirror.
    "ETD",
    "ETA",
    "departure_terminal",
    "arrival_terminal",
    "old_LTA",
  ],
  containers: ["shipping_status", "co2"],
  quotations: [
    "total_weight",
    "total_volume",
    "total_meterage",
    "total_quantity",
    "total_taxable_weight",
  ],
  // `code` is composed by the event hook from the type and the target;
  // a supplied one is silently replaced.
  events: ["code"],
  entities: ["association_key"],
  // Maintained by `address-access`: the hook strips it off any payload and
  // rebuilds the junction from the owning entity.
  address: ["access_entities"],
};

/** Computed columns of `collection`, universal ones included. */
export const computedFieldsOf = (collection: string): readonly string[] => [
  ...UNIVERSAL_COMPUTED,
  ...(COMPUTED_FIELDS[collection] ?? []),
];

export interface StripResult {
  data: Record<string, unknown>;
  /** Field names removed — echoed back so the agent stops sending them. */
  stripped: string[];
}

/**
 * Remove the computed columns from one write payload.
 *
 * `entity_id` goes too on UPDATE only: `ownership-guard` rejects a change
 * of owner on an existing row, and the agent that sends it is usually
 * echoing back a row it just read.
 */
export const stripComputed = (
  collection: string,
  data: Record<string, unknown>,
  mode: "create" | "update",
): StripResult => {
  const computed = new Set(computedFieldsOf(collection));
  if (mode === "update") computed.add("entity_id");

  const out: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (computed.has(key)) {
      stripped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { data: out, stripped };
};

// ── Relation shapes ───────────────────────────────────────────────────

/** Directus' advanced list syntax — passed through untouched. */
const isRelationOpsObject = (value: unknown): boolean =>
  isRecord(value) &&
  ("create" in value || "update" in value || "delete" in value);

const describeShape = (field: string, shape: PbypRelationShape): string => {
  if (shape.kind === "m2o") {
    return `${field} is a link to ${shape.to}: send its id (a number), or a nested object to create the row.`;
  }
  if (shape.kind === "o2m") {
    return `${field} is a list of ${shape.to} rows: send [{ …fields }] — each row is linked back through "${shape.fk}".`;
  }
  return `${field} is a many-to-many to ${shape.to} through ${shape.through}: send [{ "${shape.otherFk}": <${shape.to} id> }], NOT a list of bare ids.`;
};

/**
 * Collections whose rows can be archived — every one whose `status` offers
 * `archived`, read off the snapshot rather than listed by hand.
 *
 * Pbyp cancels by archiving, so an unfiltered read of any of these mixes
 * live shipments with cancelled ones. The typed searches used to exclude
 * them; `query_items` has to do it now, or "how many are in transit"
 * quietly counts cancellations.
 */
export const PUBLISHABLE_COLLECTIONS: ReadonlySet<string> = new Set(
  Object.entries(PBYP_SCHEMA)
    .filter(([, def]) => def.fields.status?.choices?.includes("archived"))
    .map(([name]) => name),
);

/**
 * The prefix to put in `fields` or `filter` to reach ACROSS this link.
 *
 * The read-side twin of `describeShape`, and the same trap in the other
 * direction: on a many-to-many, `air_folders.id` is the id of the JUNCTION
 * row, not of the folder. Directus answers it without complaint, so the
 * caller joins onto unrelated records and gets a plausible wrong answer —
 * observed 08/09, where folder 119 came back as "42" and the agent
 * concluded, reasonably and wrongly, that the linked folders were stale
 * test data.
 *
 * `describe_collection` hands this string to the agent so it copies a path
 * instead of deriving one.
 */
export const relationPath = (
  field: string,
  shape: PbypRelationShape,
): string => (shape.kind === "m2m" ? `${field}.${shape.otherFk}` : field);

/**
 * Walk a dotted field path through the schema. Returns the reason it does
 * not resolve, or `undefined` when it does.
 *
 * This is the local answer to Directus' worst read behaviour: a nested path
 * it does not recognise is neither rejected nor honoured — it silently
 * returns the raw foreign key, so a wrong path reads as "nested fields do
 * not work here". A path whose FIRST segment is unknown fares differently
 * but no better: a 403 naming a permission problem that is really a typo.
 * Both become one sentence, before the request leaves.
 */
export const resolveFieldPath = (
  collection: string,
  path: string,
): string | undefined => {
  // Wildcards and Directus functions (`count(x)`, `year(date)`) are the
  // server's business, not ours.
  if (path.includes("*") || path.includes("(")) return undefined;

  const segments = path.split(".");
  let current = collection;
  let i = 0;
  while (i < segments.length) {
    const segment = segments[i] ?? "";
    const field = PBYP_SCHEMA[current]?.fields[segment];
    if (field === undefined) {
      const known = Object.keys(PBYP_SCHEMA[current]?.fields ?? {});
      const near = known.filter(
        (name) => name.includes(segment) || segment.includes(name),
      );
      return `"${path}": ${current} has no column "${segment}"${
        near.length > 0 ? ` — did you mean ${near.slice(0, 3).join(", ")}?` : ""
      }`;
    }
    if (i === segments.length - 1) return undefined;

    const shape = field.relation;
    if (shape === undefined) {
      return `"${path}": ${current}.${segment} is a plain column, there is nothing to traverse.`;
    }
    if (shape.kind === "m2m") {
      const next = segments[i + 1];
      if (next !== shape.otherFk) {
        return `"${path}": ${segment} is a many-to-many — go through "${segment}.${shape.otherFk}", never "${segment}.id" (that is the junction row's own id, and Directus answers it without an error).`;
      }
      i += 1;
    }
    current = shape.to;
    i += 1;
  }
  return undefined;
};

/**
 * Reject a relational value whose shape Directus would misread.
 *
 * The case that justifies this: `parcels: [41, 42]` on an order looks
 * right and is accepted, but Directus reads those numbers as ids of
 * `orders_parcels` JUNCTION rows — so it links two unrelated parcels and
 * reports success. Nothing downstream ever flags it. The correct payload
 * is `[{ "parcels_id": 41 }, { "parcels_id": 42 }]`.
 */
export const assertRelationShapes = (
  collection: string,
  data: Record<string, unknown>,
): void => {
  const def = PBYP_SCHEMA[collection];
  if (def === undefined) return;

  for (const [field, value] of Object.entries(data)) {
    const shape = def.fields[field]?.relation;
    if (shape === undefined || value === null || value === undefined) continue;

    if (shape.kind === "m2o") {
      if (
        typeof value === "number" ||
        typeof value === "string" ||
        isRecord(value)
      ) {
        continue;
      }
      throw new Error(describeShape(field, shape));
    }

    if (isRelationOpsObject(value)) continue;
    if (!Array.isArray(value)) throw new Error(describeShape(field, shape));

    if (shape.kind === "o2m") continue;

    for (const entry of value) {
      if (!isRecord(entry)) throw new Error(describeShape(field, shape));
      // `id` alone keeps an existing junction row — legitimate on update.
      if (!(shape.otherFk in entry) && !("id" in entry)) {
        throw new Error(describeShape(field, shape));
      }
    }
  }
};

// ── Value formats ─────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 6346 letter weights: 10 upwards, skipping every multiple of 11
 * (so A=10, B=12, …, L=23, …, V=34, …, Z=38).
 */
const LETTER_VALUES: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  let n = 10;
  for (let i = 0; i < 26; i += 1) {
    if (n % 11 === 0) n += 1;
    table[String.fromCharCode(65 + i)] = n;
    n += 1;
  }
  return table;
})();

/**
 * ISO 6346 check digit. `TMPU0000003` — Pbyp's own placeholder for cargo
 * not yet stuffed into a known box — is accepted verbatim.
 */
export const isValidContainerNumber = (value: string): boolean => {
  const number = value.trim().toUpperCase();
  if (number === "TMPU0000003") return true;
  if (!/^[A-Z]{4}\d{7}$/.test(number)) return false;

  const values: number[] = [];
  for (const c of number.slice(0, 4)) values.push(LETTER_VALUES[c] ?? 0);
  for (const c of number.slice(4, 10)) values.push(Number(c));

  const sum = values.reduce((acc, v, i) => acc + v * 2 ** i, 0);
  const check = sum % 11 === 10 ? 0 : sum % 11;
  return check === Number(number[10]);
};

export const assertContainerNumber = (value: string): void => {
  if (!isValidContainerNumber(value)) {
    throw new Error(
      `"${value}" is not a valid ISO 6346 container number (4 letters + 7 digits, last digit is a check digit). Use TMPU0000003 when the box is not known yet.`,
    );
  }
};

/** A calendar day — the API stores it verbatim, with no timezone. */
export const assertDay = (field: string, value: string): void => {
  if (!DAY.test(value)) {
    throw new Error(
      `${field} is a calendar day: send YYYY-MM-DD (got "${value}"). Instants like ETD or an event date take a full ISO timestamp instead.`,
    );
  }
};

/** An instant. A bare day here would silently mean midnight UTC. */
export const assertInstant = (field: string, value: string): void => {
  if (DAY.test(value)) {
    throw new Error(
      `${field} is an instant, not a day: send a full ISO timestamp such as ${value}T08:00:00Z.`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} is not a valid ISO timestamp (got "${value}").`);
  }
};

/**
 * Air waybill number: 3-digit airline prefix, 8 digits, the last a modulo-7
 * check of the preceding seven. Separators are tolerated on input.
 */
export const isValidLta = (value: string): boolean => {
  const compact = value.replace(/[\s-]/g, "");
  if (!/^\d{11}$/.test(compact)) return false;
  const serial = compact.slice(3, 10);
  return Number(serial) % 7 === Number(compact[10]);
};

// ── Response hygiene ──────────────────────────────────────────────────

/** Keys never worth carrying into a transcript, at any depth. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  // A gateway's static token. `/items/gateway_external` hands it to any
  // user who may read the row — the agent must not be the one that
  // republishes it into a conversation, a page or a file.
  "access_key",
  "token",
  "password",
]);

export const scrubSecrets = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = scrubSecrets(v);
  }
  return out;
};

/** Directus wraps every payload in `{ data }`; the bundle endpoints do not. */
export const unwrapData = (raw: unknown): unknown =>
  isRecord(raw) && "data" in raw ? raw.data : raw;

// ── Domain maps ───────────────────────────────────────────────────────

/**
 * The six object families an event or a share can hang off, and the alias
 * that walks the junction from either side. `orders.events` and
 * `events.orders` are both called `orders` — Directus names the alias after
 * the FAR collection, which is why one map serves both directions.
 */
export const TARGETS: Readonly<
  Record<string, { collection: string; junction: string }>
> = {
  order: { collection: "orders", junction: "orders" },
  sea_folder: { collection: "sea_folders", junction: "sea_folders" },
  air_folder: { collection: "air_folders", junction: "air_folders" },
  sea_booking: { collection: "sea_bookings", junction: "sea_bookings" },
  air_booking: { collection: "air_bookings", junction: "air_bookings" },
  container: { collection: "containers", junction: "containers" },
  quotation: { collection: "quotations", junction: "quotations" },
};

/** Only orders and folders are shared with another entity. */
export const SHARE_JUNCTIONS: Readonly<
  Record<string, { table: string; fk: string }>
> = {
  order: { table: "orders_entities", fk: "orders_id" },
  sea_folder: { table: "sea_folders_entities", fk: "sea_folders_id" },
  air_folder: { table: "air_folders_entities", fk: "air_folders_id" },
};

/**
 * Where an object's EDI journal row lives. Creating one IS the transfer:
 * Pbyp's hooks only ever re-export an object that already has a row.
 */
export const EDI_JOURNALS: Readonly<
  Record<string, { collection: string; column: string }>
> = {
  order: { collection: "orders_edi", column: "order_id" },
  sea_folder: { collection: "folder_edi", column: "sea_folder_id" },
  air_folder: { collection: "folder_edi", column: "air_folder_id" },
  sea_booking: { collection: "booking_edi", column: "sea_booking_id" },
  air_booking: { collection: "booking_edi", column: "air_booking_id" },
  event: { collection: "event_edi", column: "event_id" },
};

/**
 * The reference a human recognises, per collection — what an approval card
 * shows instead of a primary key. A card reading "update orders #4127" asks
 * the user to approve a number they have never seen.
 */
export const HUMAN_REFERENCE_FIELDS: Readonly<Record<string, string>> = {
  orders: "number",
  sea_folders: "folder_number",
  air_folders: "folder_number",
  sea_bookings: "booking_number",
  air_bookings: "booking_number",
  containers: "number",
  quotations: "number",
  entities: "name",
  address: "name",
  address_book: "name",
  terminals: "name",
  oversea_companies: "name",
  // `files` deliberately absent: the row carries only the binary's id and
  // its tags — the document's title lives on `directus_files`, which this
  // connection does not read.
  customers: "email",
  gateway_external: "external_code",
};
