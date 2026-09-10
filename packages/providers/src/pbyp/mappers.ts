import {
  arr,
  asNumber,
  asString,
  bool,
  isRecord,
  num,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderMappers,
  RequestMapper,
  ResponseMapper,
} from "@fretik/shared/external-apps/provider-types";
import { mimeFromFilename } from "@fretik/shared/file-types/derive";
import { PBYP_SCHEMA } from "./directus-schema";
import {
  ARCHIVABLE_COLLECTIONS,
  assertContainerNumber,
  assertRelationShapes,
  computedFieldsOf,
  CREATE_COLLECTIONS,
  DELETE_COLLECTIONS,
  EDI_JOURNALS,
  isValidLta,
  PUBLISHABLE_COLLECTIONS,
  READ_COLLECTIONS,
  relationPath,
  resolveFieldPath,
  scrubSecrets,
  SHARE_JUNCTIONS,
  stripComputed,
  TARGETS,
  unwrapData,
  UPDATE_COLLECTIONS,
} from "./invariants";
import { projectionFor } from "./projections";

/**
 * Pbyp request + response mappers.
 *
 * Two jobs. On the way out, turn the agent's flat arguments into the shape
 * Directus and the Pbyp bundle actually accept — junction rows, nested
 * creates, the module-dependent collection — and refuse the payloads that
 * would be accepted and quietly mean something else. On the way back,
 * unwrap Directus' `{ data }` envelope, drop secrets, and flatten the rows
 * into the compact shapes the manifest declares.
 *
 * Everything a test needs to pin lives in `invariants.ts`; this file is the
 * wiring.
 */

// ── Small helpers ─────────────────────────────────────────────────────

/** Values Directus wants as JSON text in the query string. */
const jsonParam = (value: unknown): string => JSON.stringify(value);

const csv = (value: unknown): string => strArray(value).join(",");

/**
 * Read a Postgres `bigint`, which Directus serialises as a STRING because
 * it does not fit a JSON number — counts, `filesize`. `num()` answers 0 for
 * every one of them, silently.
 */
const toBigInt = (value: unknown): number => {
  if (typeof value === "number") return value;
  const parsed = Number(asString(value) ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Stringify a scalar. Unlike `str()`, which answers `""` for a number,
 * because the bundle's EDI routes take their ids as strings (the interface
 * posts `gatewayType: "1"`) and an empty one silently matches nothing.
 */
const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  throw new Error(`expected a string or a number, got ${typeof value}`);
};

/** Drop keys whose value is `undefined`, keeping `null` (an explicit clear). */
const defined = (row: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

const requireRecords = (
  value: unknown,
  what: string,
): Record<string, unknown>[] => {
  const list = arr(value);
  if (list.length === 0) throw new Error(`${what} must not be empty`);
  return list.map((item) => {
    if (!isRecord(item)) throw new Error(`${what} must contain objects`);
    return item;
  });
};

const requireIds = (value: unknown, what: string): number[] => {
  const ids = arr(value)
    .map((v) => asNumber(v))
    .filter((v): v is number => v !== undefined);
  if (ids.length === 0) throw new Error(`${what} must contain at least one id`);
  return ids;
};

// ── Module-dependent collections ──────────────────────────────────────

const moduleOf = (args: Record<string, unknown>): "sea" | "air" => {
  const value = args.module;
  if (value === "sea" || value === "air") return value;
  throw new Error('module must be "sea" or "air"');
};

const folderCollection = (module: "sea" | "air"): string =>
  module === "sea" ? "sea_folders" : "air_folders";

const bookingCollection = (module: "sea" | "air"): string =>
  module === "sea" ? "sea_bookings" : "air_bookings";

const targetOf = (
  value: unknown,
): { collection: string; junction: string; key: string } => {
  const key = str(value);
  const target = TARGETS[key];
  if (target === undefined) throw new Error(`Unknown target type "${key}"`);
  return { ...target, key };
};

// ── Guards shared by the generic writes ───────────────────────────────

/**
 * Collections whose name contains the one that was asked for.
 *
 * Measured: an agent looking for the carrier catalogue asked for
 * `companies`, which is the FIELD on `sea_bookings`; the table is
 * `oversea_companies`. Naming the near misses turns a dead end into the
 * next call — the alternative is the agent guessing again.
 */
const nearestCollections = (wanted: string): string[] =>
  [...READ_COLLECTIONS]
    .filter((name) => name.includes(wanted) || wanted.includes(name))
    .slice(0, 4);

const assertReadable = (collection: string): void => {
  if (READ_COLLECTIONS.has(collection)) return;
  const near = nearestCollections(collection);
  throw new Error(
    `"${collection}" is not a Pbyp collection.${
      near.length > 0 ? ` Did you mean ${near.join(", ")}?` : ""
    } A field of a collection is not a collection — describe_collection() on the table itself names its columns and where each link points.`,
  );
};

const assertCreatable = (collection: string): void => {
  assertReadable(collection);
  if (CREATE_COLLECTIONS.has(collection)) return;
  if (collection === "gateway_external") {
    throw new Error(
      "Gateways are not created through /items — use create_gateway(), which also provisions the partner's access account.",
    );
  }
  throw new Error(
    `Pbyp does not allow creating rows in "${collection}" — it is reference data maintained by the platform.`,
  );
};

const assertUpdatable = (collection: string): void => {
  assertReadable(collection);
  if (UPDATE_COLLECTIONS.has(collection)) return;
  throw new Error(
    `Pbyp does not allow updating "${collection}" — it is reference data maintained by the platform.`,
  );
};

const assertDeletable = (collection: string): void => {
  assertReadable(collection);
  if (DELETE_COLLECTIONS.has(collection)) return;
  if (ARCHIVABLE_COLLECTIONS.has(collection)) {
    throw new Error(
      `Pbyp never deletes a ${collection} row — cancel it with archive(), which sets the status to CANCELED and cascades to the objects that depend on it.`,
    );
  }
  throw new Error(`Pbyp does not allow deleting rows in "${collection}".`);
};

/**
 * The one channel from a request mapper to its own response mapper.
 *
 * `buildRequest` gives a request mapper no way to pass anything to the
 * response side except the request itself, and two things genuinely need
 * to cross: which computed columns were stripped (so the answer can tell
 * the agent to stop sending them), and which event-type filter to apply
 * (Directus refuses every containment operator on a `json` column, so
 * `modules` and `category` can only be filtered after the fact).
 *
 * Safe HERE and nowhere else: this provider declares `concurrency: serial`,
 * so the dispatcher runs one op at a time on a connection and the value is
 * consumed by the very next response. Each mapper clears what it reads.
 */
const pending: {
  stripped: string[];
  eventTypeFilter: { module?: string; category?: string };
} = { stripped: [], eventTypeFilter: {} };

const sanitiseWrite = (
  collection: string,
  row: Record<string, unknown>,
  mode: "create" | "update",
): Record<string, unknown> => {
  const { data, stripped } = stripComputed(collection, row, mode);
  assertRelationShapes(collection, data);
  pending.stripped = stripped;
  return data;
};

// ── Generic actions ───────────────────────────────────────────────────

/** At most this many collections per `describe_collection`. */
const DESCRIBE_LIMIT = 5;

/**
 * `GET /fields` returns all 91 collections at once (1.1 MB, ~0.45 s) where
 * `/fields/{collection}` returns one (33 KB, ~0.12 s). We take the whole
 * thing on purpose: the mapper trims it to the collections asked for, so
 * the agent pays nothing extra in context, and describing three tables
 * costs ONE tool call instead of three round-trips through the model.
 */
const describeFields: RequestMapper = (args) => {
  const names = strArray(args.collections);
  if (names.length === 0) {
    throw new Error("collections must name at least one collection");
  }
  if (names.length > DESCRIBE_LIMIT) {
    throw new Error(
      `describe_collection takes at most ${DESCRIBE_LIMIT.toString()} collections at a time; got ${names.length.toString()}.`,
    );
  }
  for (const name of names) assertReadable(name);
  return { endpoint: "/fields" };
};

const queryItems: RequestMapper = (args) => {
  const collection = str(args.collection);
  assertReadable(collection);

  const aggregating = args.aggregate !== undefined;

  // Two rules Directus enforces badly or not at all. Answering them here
  // costs nothing and names the fix; letting them through costs a round
  // trip and, for the first, a wrong answer that looks right.
  for (const path of strArray(args.fields)) {
    const problem = resolveFieldPath(collection, path);
    if (problem !== undefined) throw new Error(problem);
  }
  for (const key of strArray(args.group_by)) {
    if (!key.includes(".")) continue;
    const [head] = key.split(".");
    throw new Error(
      `group_by cannot follow a relation ("${key}" answers 500). Group on "${head ?? ""}" — the id column — then resolve the ids you keep in one more read.`,
    );
  }

  const query: Record<string, string> = {};
  if (args.sort !== undefined) query.sort = csv(args.sort);
  if (args.search !== undefined) query.search = str(args.search);
  if (args.deep !== undefined) query.deep = jsonParam(args.deep);
  if (aggregating) query.aggregate = jsonParam(args.aggregate);
  if (args.group_by !== undefined) query.groupBy = csv(args.group_by);

  // Pbyp cancels by archiving, so an unfiltered read mixes live rows with
  // cancelled ones. The typed searches used to exclude them; this is where
  // that guarantee now lives. A caller who filters on `status` themselves
  // owns the question and is left alone.
  const filter = isRecord(args.filter) ? args.filter : undefined;
  const clause =
    bool(args.include_archived) ||
    !PUBLISHABLE_COLLECTIONS.has(collection) ||
    JSON.stringify(filter ?? {}).includes('"status"')
      ? undefined
      : { status: { _eq: "published" } };
  const merged = withFilters([filter, clause]);
  if (merged !== undefined) query.filter = jsonParam(merged);

  // With `groupBy`, Directus applies `limit` to the number of GROUPS, and
  // OMITTING it does not lift the cap — the server falls back to 100.
  // Measured: grouping 485 folders by voyage returns 100 groups with no
  // limit and 325 with `-1`. A truncated count is a wrong answer that reads
  // as a right one, so an aggregate always asks for every group.
  if (aggregating) {
    query.limit = "-1";
  } else {
    const limit = num(args.limit, 25);
    if (limit === 0) {
      throw new Error("limit 0 returns nothing; use -1 for every row.");
    }
    query.limit = limit.toString();
    // `page` is meaningless against an unbounded read and Directus ignores it.
    if (limit > 0) query.page = num(args.page, 1).toString();
  }

  // An explicit `fields` wins; otherwise the curated projection resolves
  // relations to names instead of ids. Skipped for an aggregate (Directus
  // will not combine the two) and for `deep`, whose clauses only apply to
  // relations the projection actually selects — a default that omits them
  // turns the whole `deep` into a silent no-op.
  if (args.fields !== undefined) {
    query.fields = csv(args.fields);
  } else if (!aggregating && args.deep === undefined) {
    const projection = projectionFor(collection);
    if (projection !== undefined) query.fields = projection;
  }

  return { endpoint: `/items/${collection}`, query };
};

const createItems: RequestMapper = (args) => {
  const collection = str(args.collection);
  assertCreatable(collection);
  const rows = requireRecords(args.items, "items");
  const stripped = new Set<string>();
  const body = rows.map((row) => {
    const clean = sanitiseWrite(collection, row, "create");
    for (const name of pending.stripped) stripped.add(name);
    return clean;
  });
  pending.stripped = [...stripped];
  return { endpoint: `/items/${collection}`, body };
};

const updateItems: RequestMapper = (args) => {
  const collection = str(args.collection);
  assertUpdatable(collection);
  const keys = requireIds(args.ids, "ids");
  if (!isRecord(args.data)) throw new Error("data must be an object");
  const data = sanitiseWrite(collection, args.data, "update");
  if (Object.keys(data).length === 0) {
    throw new Error(
      "Nothing left to update once the computed columns were removed.",
    );
  }
  return { endpoint: `/items/${collection}`, body: { keys, data } };
};

const deleteItems: RequestMapper = (args) => {
  const collection = str(args.collection);
  assertDeletable(collection);
  return {
    endpoint: `/items/${collection}`,
    body: requireIds(args.ids, "ids"),
  };
};

/**
 * Larger than any shipping document, small enough that passing the wrong
 * variable fails here instead of after a long upload.
 */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Standard base64, after whitespace has been folded out. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `POST /files` is the one Directus route that takes a body Fretik cannot
 * express as JSON, and the only way bytes ever enter Pbyp's storage. It
 * files nothing on its own: the document becomes a document once a `files`
 * row points at this uuid and a junction points at that row, which is one
 * ordinary `create_items` (see the guidance).
 *
 * Both checks below exist because their failure is silent otherwise:
 * `Buffer.from` DROPS characters it does not recognise instead of throwing,
 * so a base64 string with a stray prefix uploads a truncated file that
 * opens as garbage, and a filename carrying a directory would be stored
 * verbatim as the download name.
 */
const uploadFile: RequestMapper = (args) => {
  const filename = str(args.filename).trim();
  if (filename === "") {
    throw new Error(
      "filename is required — the name to file the document under, with its extension.",
    );
  }
  if (filename.includes("/") || filename.includes("\\")) {
    throw new Error(
      `filename is a name, not a path ("${filename}"). Pass the last segment only.`,
    );
  }

  const base64 = str(args.content_base64).replace(/\s+/g, "");
  if (base64 === "") {
    throw new Error(
      "content_base64 is empty. Read the file's bytes and encode them: base64.b64encode(Path(p).read_bytes()).decode().",
    );
  }
  if (!BASE64.test(base64) || base64.length % 4 !== 0) {
    throw new Error(
      "content_base64 is not valid base64. Encode the raw bytes, without a data: prefix — base64.b64encode(Path(p).read_bytes()).decode().",
    );
  }
  const bytes =
    (base64.length / 4) * 3 -
    (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_UPLOAD_BYTES) {
    throw new Error(
      `${filename} is ${Math.round(bytes / 1024 / 1024).toString()} MB; the limit is ${(MAX_UPLOAD_BYTES / 1024 / 1024).toString()} MB. Split it or file a compressed copy.`,
    );
  }

  const declaredType = str(args.content_type).trim();
  const contentType =
    declaredType === "" ? mimeFromFilename(filename) : declaredType;

  return {
    multipart: {
      // Directus derives `filename_download` and `type` from the part
      // itself; `title` would otherwise be a prettified guess ("Bl Cma
      // 2026"), so send the real name.
      fields: { title: filename },
      file: { field: "file", filename, contentType, base64 },
    },
  };
};

/** `filesize` is a Postgres bigint — it arrives as a string, like every aggregate. */
const uploadedFile: ResponseMapper = (raw) => {
  const file = clean(raw);
  return {
    id: str(prop(file, "id")),
    filename_download: str(prop(file, "filename_download")),
    type: str(prop(file, "type")),
    filesize: toBigInt(prop(file, "filesize")),
  };
};

// ── Typed reads ───────────────────────────────────────────────────────

const ME_FIELDS = [
  "id",
  "email",
  "first_name",
  "last_name",
  "current_entities",
  "current_profile_id.id",
  "current_profile_id.role_id.name",
  "current_profile_id.entity_id.id",
  "current_profile_id.entity_id.name",
  "current_profile_id.entity_id.is_client",
].join(",");

const whoamiRequest: RequestMapper = () => ({ query: { fields: ME_FIELDS } });

/**
 * `$CURRENT_USER` is resolved server-side, so the caller's own profiles are
 * selected without a round trip to learn their id.
 *
 * The filter is not decoration: measured on preprod, the unfiltered read
 * answered with OTHER accounts' profiles — Pbyp's row policies are what
 * would normally narrow it, and the legacy policy still attached there
 * unions them open. An action whose summary says "the profiles this
 * account holds" has to hold that on its own.
 */
const listProfilesRequest: RequestMapper = () => ({
  query: {
    fields: "id,entity_id.id,entity_id.name,entity_id.is_client,role_id.name",
    filter: jsonParam({ user_id: { _eq: "$CURRENT_USER" } }),
    limit: "100",
  },
});

const withFilters = (
  clauses: unknown[],
): Record<string, unknown> | undefined => {
  const kept = clauses.filter((c): c is Record<string, unknown> => isRecord(c));
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { _and: kept };
};

const EVENT_FIELDS = [
  "id",
  "code",
  "date",
  "actual",
  "source",
  "comments",
  "type.id",
  "type.code",
  "type.description",
  "terminal.name",
  "address.name",
].join(",");

const listEvents: RequestMapper = (args) => {
  const target = targetOf(args.target_type);
  const targetId = asNumber(args.target_id);
  if (targetId === undefined) throw new Error("target_id must be a number");
  return {
    endpoint: "/items/events",
    query: {
      fields: EVENT_FIELDS,
      sort: "-date",
      limit: num(args.limit, 25).toString(),
      // The junction is an alias on `events`, so the filter walks it.
      filter: jsonParam({
        [target.junction]: { [`${target.collection}_id`]: { _eq: targetId } },
      }),
    },
  };
};

/**
 * `modules` and `category` are `json` columns, and Directus rejects every
 * containment operator on those outright — measured: `400 "json field type
 * does not contain the _contains filter operator"`. So the whole catalogue
 * comes back (23 rows) and the response mapper narrows it.
 */
const listEventTypes: RequestMapper = (args) => {
  pending.eventTypeFilter = {
    ...(typeof args.module === "string" ? { module: args.module } : {}),
    ...(typeof args.category === "string" ? { category: args.category } : {}),
  };
  return {
    query: {
      fields: "id,code,description,modules,category",
      sort: "code",
      limit: "100",
    },
  };
};

/**
 * `access_key` is never requested. `/items/gateway_external` hands the
 * partner's static token to anyone who may read the row, and a token that
 * reaches a transcript has effectively been published.
 */
const listGateways: RequestMapper = () => ({
  query: {
    fields:
      "id,external_code,entity_id,status,gateway_type.id,gateway_type.name",
    sort: "external_code",
    limit: "100",
  },
});

const COUNT_TARGETS: Readonly<
  Record<string, "orders" | "folder" | "booking" | "containers">
> = {
  order: "orders",
  folder: "folder",
  booking: "booking",
  container: "containers",
};

const countByStatus: RequestMapper = (args) => {
  const object = str(args.object);
  const kind = COUNT_TARGETS[object];
  if (kind === undefined) throw new Error(`Unknown object "${object}"`);

  let collection: string;
  if (kind === "orders") collection = "orders";
  else if (kind === "containers") collection = "containers";
  else {
    const module = moduleOf(args);
    collection =
      kind === "folder" ? folderCollection(module) : bookingCollection(module);
  }

  const dateColumn = collection === "orders" ? "date" : "date_created";
  const filter = withFilters([
    { status: { _eq: "published" } },
    // Orders are the only family that carries the module on the row; for
    // folders and bookings the module IS the collection.
    collection === "orders" && args.module !== undefined
      ? { transport_type: { _eq: args.module } }
      : undefined,
    args.date_from !== undefined
      ? { [dateColumn]: { _gte: args.date_from } }
      : undefined,
    args.date_to !== undefined
      ? { [dateColumn]: { _lte: args.date_to } }
      : undefined,
  ]);

  const query: Record<string, string> = {
    aggregate: jsonParam({ count: "id" }),
    groupBy: "shipping_status",
  };
  if (filter !== undefined) query.filter = jsonParam(filter);
  return { endpoint: `/items/${collection}`, query };
};

const monthCount: RequestMapper = (args) => ({
  query: { module: str(args.module) },
});

// ── Typed writes ──────────────────────────────────────────────────────

/**
 * A party: an existing address id, or the payload that creates one.
 * Directus takes a nested object on a many-to-one and creates the row.
 */
const addressPayload = (value: unknown, what: string): unknown => {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  const id = asNumber(value.id);
  if (id !== undefined) return id;
  const name = asString(value.name);
  if (name === undefined) {
    throw new Error(
      `${what} needs either { id } for an existing address, or at least { name, code, country_id | code_country } to create one.`,
    );
  }
  if (value.country_id === undefined && value.code_country === undefined) {
    throw new Error(`${what} needs country_id or code_country.`);
  }
  return defined({
    ...value,
    // Pbyp's own forms default the code to the name when the user leaves
    // it blank; the column is NOT NULL.
    code: value.code ?? name,
  });
};

/** Air cargo is billed on 1 m3 = 167 kg, sea on 1 m3 = 1000 kg. */
const taxableWeightOf = (
  parcel: Record<string, unknown>,
  module: "sea" | "air",
): number => {
  const declared = asNumber(parcel.taxable_weight);
  if (declared !== undefined) return declared;
  const volume = num(parcel.volume);
  const weight = num(parcel.weight);
  return Math.max(weight, volume * (module === "air" ? 167 : 1000));
};

const parcelRows = (
  value: unknown,
  module: "sea" | "air",
): Record<string, unknown>[] =>
  requireRecords(value, "parcels").map((parcel) =>
    defined({
      type: parcel.type,
      quantity: parcel.quantity,
      weight: parcel.weight,
      volume: parcel.volume,
      meterage: parcel.meterage,
      taxable_weight: taxableWeightOf(parcel, module),
      description: parcel.description,
      is_adr: parcel.is_adr,
      is_controlled_temperature: parcel.is_controlled_temperature,
      minimal_temperature: parcel.minimal_temperature,
      maximal_temperature: parcel.maximal_temperature,
      adr:
        parcel.adr_ids === undefined
          ? undefined
          : arr(parcel.adr_ids).map((adrId) => ({ adr_id: adrId })),
    }),
  );

/** `associated_entities` / `folders_entities` junction rows. */
const shareRows = (value: unknown): Record<string, unknown>[] =>
  requireRecords(value, "shared_with").map((share) => ({
    entities_id: share.entity_id,
    can_edit: bool(share.can_edit),
  }));

/**
 * Cargo lines as junction rows carrying a NESTED create: Directus makes the
 * parcel and the link in one write. `[{ parcels_id: { …parcel } }]`.
 */
const parcelJunctionRows = (
  value: unknown,
  module: "sea" | "air",
): Record<string, unknown>[] =>
  parcelRows(value, module).map((parcel) => ({ parcels_id: parcel }));

const createOrder: RequestMapper = (args) => {
  const module = moduleOf(args);
  const body = defined({
    number: args.number,
    transport_type: module,
    date: args.date,
    incoterm: args.incoterm,
    entity_id: args.entity_id,
    shipper: addressPayload(args.shipper, "shipper"),
    consignee: addressPayload(args.consignee, "consignee"),
    client_reference: args.client_reference,
    billing_reference: args.billing_reference,
    comments: args.comments,
    pickup_date: args.pickup_date,
    delivery_date: args.delivery_date,
    available_date: args.available_date,
    deadline: args.deadline,
    parcels_description: args.parcels_description,
    parcels_price: args.parcels_price,
    parcels_price_currency: args.parcels_price_currency,
    parcels:
      args.parcels === undefined
        ? undefined
        : parcelJunctionRows(args.parcels, module),
    associated_entities:
      args.shared_with === undefined ? undefined : shareRows(args.shared_with),
    [module === "sea" ? "sea_folders" : "air_folders"]:
      args.folder_id === undefined
        ? undefined
        : [{ [`${folderCollection(module)}_id`]: args.folder_id }],
  });
  return {
    endpoint: "/items/orders",
    body: sanitiseWrite("orders", body, "create"),
  };
};

const createFolder: RequestMapper = (args) => {
  const module = moduleOf(args);
  const collection = folderCollection(module);
  const folderType = str(args.folder_type);

  if (folderType === "house" && args.master_id === undefined) {
    throw new Error("A house folder must name the master_id it belongs to.");
  }
  if (folderType !== "master" && args.payer_id === undefined) {
    throw new Error(
      "payer_id is required on a single or house folder — it is the entity that gets billed.",
    );
  }

  const body = defined({
    folder_type: folderType,
    date: args.date,
    incoterm: args.incoterm,
    entity_id: args.entity_id,
    shipper: addressPayload(args.shipper, "shipper"),
    consignee: addressPayload(args.consignee, "consignee"),
    payer_id: args.payer_id,
    master_id: args.master_id,
    voyage_id: args.voyage_id,
    client_reference: args.client_reference,
    billing_reference: args.billing_reference,
    comments: args.comments,
    pickup_date: args.pickup_date,
    delivery_date: args.delivery_date,
    orders:
      args.order_ids === undefined
        ? undefined
        : arr(args.order_ids).map((orderId) => ({ orders_id: orderId })),
    parcels:
      args.parcels === undefined
        ? undefined
        : parcelJunctionRows(args.parcels, module),
    folders_entities:
      args.shared_with === undefined ? undefined : shareRows(args.shared_with),
  });
  return {
    endpoint: `/items/${collection}`,
    body: sanitiseWrite(collection, body, "create"),
  };
};

const createSeaBooking: RequestMapper = (args) => {
  if (args.company_id !== undefined && args.custom_company !== undefined) {
    throw new Error(
      "Give either company_id (a listed shipping line) or custom_company (a free-text name), not both.",
    );
  }
  const containers = arr(args.containers).map((entry) => {
    if (!isRecord(entry)) throw new Error("containers must contain objects");
    const number = str(entry.number);
    assertContainerNumber(number);
    return defined({
      number: number.toUpperCase(),
      type: entry.type,
      shipping_method: entry.shipping_method,
    });
  });

  const body = defined({
    booking_number: args.booking_number,
    entity_id: args.entity_id,
    booking_type: args.booking_type,
    ship_name: args.ship_name,
    voyage_number: args.voyage_number,
    BL_number: args.BL_number,
    agent_code: args.agent_code,
    companies:
      args.company_id === undefined
        ? undefined
        : [{ oversea_companies_id: args.company_id }],
    custom_company: args.custom_company,
    departure_terminal: args.departure_terminal,
    arrival_terminal: args.arrival_terminal,
    ETD: args.ETD,
    ETA: args.ETA,
    containers: containers.length > 0 ? containers : undefined,
  });
  return {
    endpoint: "/items/sea_bookings",
    body: sanitiseWrite("sea_bookings", body, "create"),
  };
};

const createAirBooking: RequestMapper = (args) => {
  const lta = asString(args.LTA);
  if (lta !== undefined && lta.length > 0 && !isValidLta(lta)) {
    throw new Error(
      `"${lta}" is not a valid air waybill number: 3-digit airline prefix + 8 digits, the last one a modulo-7 check of the preceding seven.`,
    );
  }
  const flights = requireRecords(args.flights, "flights").map((flight) =>
    defined({
      number: flight.number,
      pol: flight.pol,
      pod: flight.pod,
      etd: flight.etd,
      eta: flight.eta,
    }),
  );

  const body = defined({
    booking_number: args.booking_number,
    entity_id: args.entity_id,
    booking_type: args.booking_type,
    LTA: lta,
    voyage_number: args.voyage_number,
    agent_code: args.agent_code,
    airline_company: args.airline_company,
    custom_company: args.custom_company,
    flights,
  });
  return {
    endpoint: "/items/air_bookings",
    body: sanitiseWrite("air_bookings", body, "create"),
  };
};

/**
 * `client` and `freight_forwarder` are BOTH NOT NULL, but Pbyp fills the
 * caller's own side from `entity_id` (`FilterUpsertQuotationSetClientForwarder`
 * reads its `is_client`). So the action asks for the other side once, under
 * a name that does not require the agent to know which it is, and sends it
 * to both columns — the hook overwrites the one that is ours.
 */
const createQuotation: RequestMapper = (args) => {
  const module = str(args.transport_type) === "air" ? "air" : "sea";
  const body = defined({
    number: args.number,
    entity_id: args.entity_id,
    transport_type: args.transport_type,
    booking_type: args.booking_type,
    incoterm: args.incoterm,
    margin: args.margin,
    client: args.counterparty,
    freight_forwarder: args.counterparty,
    shipper: addressPayload(args.shipper, "shipper"),
    consignee: addressPayload(args.consignee, "consignee"),
    departure_terminal: args.departure_terminal,
    arrival_terminal: args.arrival_terminal,
    etd: args.etd,
    eta: args.eta,
    validity_start_date: args.validity_start_date,
    validity_end_date: args.validity_end_date,
    comments: args.comments,
    quotation_status: "DRAFT",
    parcels:
      args.parcels === undefined
        ? undefined
        : parcelJunctionRows(args.parcels, module),
    quotes:
      args.quotes === undefined
        ? undefined
        : requireRecords(args.quotes, "quotes").map((quote) =>
            defined({
              code: quote.code,
              name: quote.name,
              type: quote.type,
              currency: quote.currency,
              amount_currency: quote.amount_currency,
              conversion_rate: quote.conversion_rate ?? 1,
              amount_default_entity_currency:
                num(quote.amount_currency) * num(quote.conversion_rate, 1),
            }),
          ),
  });
  return {
    endpoint: "/items/quotations",
    body: sanitiseWrite("quotations", body, "create"),
  };
};

/**
 * Exactly ONE junction, and never `code`.
 *
 * The event hook rejects a payload carrying zero or two targets with a bare
 * `INVALID_PAYLOAD_ERROR`, so building the single junction here is what
 * makes the action usable at all.
 */
const addEvent: RequestMapper = (args) => {
  const target = targetOf(args.target_type);
  const targetId = asNumber(args.target_id);
  if (targetId === undefined) throw new Error("target_id must be a number");

  const date = str(args.date);
  const actual =
    args.actual === undefined
      ? Date.parse(date) <= Date.now()
      : bool(args.actual);

  return {
    endpoint: "/items/events",
    body: defined({
      type: args.event_type_id,
      date,
      actual,
      source: "user",
      terminal: args.terminal_id,
      address: args.address_id,
      comments: args.comments,
      [target.junction]: [{ [`${target.collection}_id`]: targetId }],
    }),
  };
};

const setParcels: RequestMapper = (args) => {
  const target = targetOf(args.target_type);
  const module = target.collection === "air_folders" ? "air" : "sea";
  const targetId = asNumber(args.target_id);
  if (targetId === undefined) throw new Error("target_id must be a number");
  const rows = parcelRows(args.parcels, module).map((parcels_id) => ({
    parcels_id,
  }));
  return {
    endpoint: `/items/${target.collection}/${targetId.toString()}`,
    body: { parcels: rows },
  };
};

const junctionOfFolder = (module: "sea" | "air"): string =>
  module === "sea" ? "sea_folders_orders" : "air_folders_orders";

const attachOrderToFolder: RequestMapper = (args) => {
  const module = moduleOf(args);
  return {
    endpoint: `/items/${junctionOfFolder(module)}`,
    body: {
      orders_id: args.order_id,
      [`${folderCollection(module)}_id`]: args.folder_id,
    },
  };
};

const detachOrderFromFolder: RequestMapper = (args) => {
  const module = moduleOf(args);
  return {
    endpoint: `/items/${junctionOfFolder(module)}`,
    body: {
      query: {
        filter: {
          orders_id: { _eq: args.order_id },
          [`${folderCollection(module)}_id`]: { _eq: args.folder_id },
        },
      },
    },
  };
};

const shareJunction = (value: unknown): { table: string; fk: string } => {
  const junction = SHARE_JUNCTIONS[str(value)];
  if (junction === undefined) {
    throw new Error("Only an order or a folder can be shared with an entity.");
  }
  return junction;
};

const shareWithEntity: RequestMapper = (args) => {
  const junction = shareJunction(args.object);
  return {
    endpoint: `/items/${junction.table}`,
    body: {
      [junction.fk]: args.object_id,
      entities_id: args.entity_id,
      can_edit: bool(args.can_edit),
    },
  };
};

const revokeShare: RequestMapper = (args) => {
  const junction = shareJunction(args.object);
  return {
    endpoint: `/items/${junction.table}`,
    body: {
      query: {
        filter: {
          [junction.fk]: { _eq: args.object_id },
          entities_id: { _eq: args.entity_id },
        },
      },
    },
  };
};

const archiveObject: RequestMapper = (args) => {
  const target = targetOf(args.object);
  const objectId = asNumber(args.object_id);
  if (objectId === undefined) throw new Error("object_id must be a number");
  return {
    endpoint: `/items/${target.collection}/${objectId.toString()}`,
    body: { status: "archived" },
  };
};

const setQuotationStatus: RequestMapper = (args) => {
  const quotationId = asNumber(args.quotation_id);
  if (quotationId === undefined) {
    throw new Error("quotation_id must be a number");
  }
  return {
    endpoint: `/items/quotations/${quotationId.toString()}`,
    body: { quotation_status: args.quotation_status },
  };
};

/**
 * The EDI journal row IS the transfer. Pbyp's hooks never create the first
 * one — they only re-export an object that already has a row — so this is
 * the single act that puts an object in front of a partner.
 */
const transferToGateway: RequestMapper = (args) => {
  const object = str(args.object);
  const journal = EDI_JOURNALS[object];
  if (journal === undefined) {
    throw new Error(`"${object}" cannot be transferred to a gateway.`);
  }
  if (object !== "event" && args.external_reference !== undefined) {
    throw new Error(
      "external_reference only applies to an event transfer — for an order, a folder or a booking the partner's reference lives in external_references.",
    );
  }
  return {
    endpoint: `/items/${journal.collection}`,
    body: defined({
      [journal.column]: args.object_id,
      gateway_external_id: args.gateway_id,
      // The quadruplet: ours to send, not yet acknowledged, first export.
      is_pbyp_export: true,
      is_updated: false,
      receive_validation: false,
      external_reference: args.external_reference,
    }),
  };
};

const assignContainers: RequestMapper = (args) => {
  const scope = str(args.scope);
  const linkKey =
    scope === "order" ? "order_container_type" : "folder_container_type";
  const body = requireRecords(args.items, "items").map((item) => {
    const linkType = str(item.container_link_type);
    if (linkType === "full" && item.container_id === undefined) {
      throw new Error(
        "container_id is required when container_link_type is full.",
      );
    }
    if (linkType === "dispatched" && item.parcels === undefined) {
      throw new Error(
        "parcels is required when container_link_type is dispatched — each line names the container it goes into.",
      );
    }
    return defined({
      id: item.id,
      [linkKey]: linkType,
      container_id: item.container_id,
      parcels:
        item.parcels === undefined
          ? undefined
          : requireRecords(item.parcels, "parcels").map((parcel) =>
              defined({
                id: parcel.id,
                type: parcel.type,
                quantity: parcel.quantity,
                weight: parcel.weight ?? 0,
                volume: parcel.volume ?? 0,
                meterage: parcel.meterage ?? 0,
                taxable_weight: parcel.taxable_weight ?? 0,
                container: { id: parcel.container_id },
              }),
            ),
    });
  });
  return {
    endpoint: `/${scope === "order" ? "order" : "folder"}-endpoints/assign_containers`,
    body,
  };
};

const unassignParcelContainer: RequestMapper = (args) => {
  const scope = str(args.scope);
  const isOrder = scope === "order";
  return {
    endpoint: `/${isOrder ? "order" : "folder"}-endpoints/parcel_container`,
    body: {
      [isOrder ? "order_id" : "folder_id"]: args.target_id,
      parcel_id: args.parcel_id,
    },
  };
};

const createGateway: RequestMapper = (args) => ({
  body: {
    gatewayType: text(args.gateway_type),
    externalCode: args.external_code,
    entityId: args.entity_id,
  },
});

const updateGateway: RequestMapper = (args) => ({
  body: {
    ediId: args.gateway_id,
    gatewayType: text(args.gateway_type),
    externalCode: args.external_code,
  },
});

const declareTracking: RequestMapper = (args) => ({
  body: { booking_id: args.booking_id, booking_type: moduleOf(args) },
});

const createLtaStock: RequestMapper = (args) => ({
  body: {
    firstAwb: args.first_awb,
    lastAwb: args.last_awb,
    airlineCompany: args.airline_company,
    entity_id: args.entity_id,
  },
});

const inviteUser: RequestMapper = (args) => ({
  body: {
    first_name: args.first_name,
    last_name: args.last_name,
    email: args.email,
    phone: args.phone ?? null,
    role_id: args.role_id,
    entity_id: args.entity_id,
  },
});

const createClient: RequestMapper = (args) => {
  if (!isRecord(args.address)) throw new Error("address must be an object");
  return {
    body: {
      agency_id: args.agency_id,
      name: args.name,
      admin_user: args.admin_user,
      commercial: args.commercial,
      address: addressPayload(args.address, "address"),
    },
  };
};

// ── Response mappers ──────────────────────────────────────────────────

const clean = (raw: unknown): unknown => scrubSecrets(unwrapData(raw));

const rows = (raw: unknown): Record<string, unknown>[] => {
  const value = clean(raw);
  return arr(value).filter(isRecord);
};

/**
 * The shape of one or more collections, as the agent needs to USE it.
 *
 * Live field metadata from `/fields`, merged with two things the API does
 * not expose and the agent previously had to guess:
 *
 *  - `path` — the literal string to paste into `fields` or `filter` to
 *    reach across a link. A many-to-many needs its junction key
 *    (`air_folders.air_folders_id`); asking for `air_folders.id` returns
 *    the JUNCTION row's id, which Directus answers WITHOUT an error, so a
 *    wrong guess produces a plausible wrong join rather than a failure.
 *  - `computed` — the columns a Pbyp hook owns. `stripComputed` already
 *    removes them from writes; saying so here is what stops the agent
 *    sending them in the first place.
 *
 * Both come from the committed snapshot, which is what every other guard in
 * this provider already trusts — so what the agent is told matches what the
 * guards will enforce.
 */
const describeCollection: ResponseMapper = (raw, args) => {
  const wanted = new Set(strArray(args?.collections));

  // `unwrapData` only, deliberately: `clean` would deep-rebuild 845 field
  // descriptors to look for secrets that schema metadata cannot contain,
  // and 95% of them are about to be discarded. Filter first.
  const out: Record<string, unknown>[] = [];
  for (const field of arr(unwrapData(raw)).filter(isRecord)) {
    const collection = asString(field.collection);
    if (collection === undefined || !wanted.has(collection)) continue;

    const name = str(field.field);
    const meta = field.meta;
    const choices = arr(prop(prop(meta, "options"), "choices"))
      .map((choice) => asString(prop(choice, "value")))
      .filter((v): v is string => v !== undefined);
    const shape = PBYP_SCHEMA[collection]?.fields[name]?.relation;

    out.push(
      defined({
        collection,
        field: name,
        type: field.type,
        required: prop(meta, "required") === true ? true : undefined,
        computed: computedFieldsOf(collection).includes(name)
          ? true
          : undefined,
        links_to: shape?.to,
        path: shape === undefined ? undefined : relationPath(name, shape),
        choices: choices.length > 0 ? choices : undefined,
        note: prop(meta, "note") ?? undefined,
      }),
    );
  }
  return out;
};

const itemsResult: ResponseMapper = (raw) => ({ items: clean(raw) });

/**
 * A write's answer plus the columns we removed on the way out. Reporting
 * them is what stops the agent re-sending `shipping_status` on every
 * subsequent call — an error the API never complains about.
 */
const writeResult: ResponseMapper = (raw) => {
  const value = clean(raw);
  const stripped = pending.stripped;
  pending.stripped = [];
  const base = Array.isArray(value)
    ? { ids: value.map((row) => prop(row, "id")) }
    : isRecord(value)
      ? value
      : { result: value };
  return stripped.length > 0 ? { ...base, stripped } : base;
};

const whoami: ResponseMapper = (raw) => {
  const me = clean(raw);
  const profile = prop(me, "current_profile_id");
  const entity = prop(profile, "entity_id");
  return defined({
    user_id: prop(me, "id"),
    email: prop(me, "email"),
    name: `${str(prop(me, "first_name"))} ${str(prop(me, "last_name"))}`.trim(),
    profile_id: prop(profile, "id"),
    profile_role: prop(prop(profile, "role_id"), "name"),
    entity_id: prop(entity, "id"),
    entity_name: prop(entity, "name"),
    is_client: prop(entity, "is_client"),
    current_entities: arr(prop(me, "current_entities")),
  });
};

const profileList: ResponseMapper = (raw) =>
  rows(raw).map((profile) => {
    const entity = prop(profile, "entity_id");
    return defined({
      id: profile.id,
      entity_id: prop(entity, "id"),
      entity_name: prop(entity, "name"),
      is_client: prop(entity, "is_client"),
      role: prop(prop(profile, "role_id"), "name"),
    });
  });

/** Event type labels are `[{ lang, name }]`; pick English, else the first. */
const labelOf = (description: unknown): string | undefined => {
  const list = arr(description);
  const english = list.find((entry) => {
    const lang = asString(prop(entry, "lang"));
    return lang !== undefined && lang.startsWith("en");
  });
  const picked = english ?? list[0];
  return (
    asString(prop(picked, "name")) ??
    asString(prop(picked, "title")) ??
    asString(prop(picked, "description"))
  );
};

const eventRows: ResponseMapper = (raw) =>
  rows(raw).map((row) =>
    defined({
      id: row.id,
      code: row.code,
      type_id: prop(row.type, "id"),
      label: labelOf(prop(row.type, "description")),
      date: row.date,
      actual: row.actual,
      source: row.source,
      terminal: prop(row.terminal, "name"),
      address: prop(row.address, "name"),
      comments: row.comments,
    }),
  );

const eventTypeRows: ResponseMapper = (raw) => {
  const { module, category } = pending.eventTypeFilter;
  pending.eventTypeFilter = {};
  return rows(raw)
    .filter((row) => {
      if (module !== undefined && !strArray(row.modules).includes(module)) {
        return false;
      }
      return (
        category === undefined || strArray(row.category).includes(category)
      );
    })
    .map((row) =>
      defined({
        id: row.id,
        code: row.code,
        label: labelOf(row.description),
        modules: arr(row.modules),
        category: arr(row.category),
      }),
    );
};

const gatewayRows: ResponseMapper = (raw) =>
  rows(raw).map((row) =>
    defined({
      id: row.id,
      external_code: row.external_code,
      gateway_type: prop(row.gateway_type, "id"),
      gateway_label: prop(row.gateway_type, "name"),
      entity_id: row.entity_id,
      status: row.status,
    }),
  );

/**
 * Directus nests an aggregate under its function name (`{"count": {"id":
 * "188"}}`); the value itself is a bigint, so it arrives as a STRING like
 * every other one. `num()` would answer 0 for every row, which is exactly
 * what preprod returned before this: every status reported as empty, with
 * no error anywhere.
 */
const toCount = (value: unknown): number =>
  toBigInt(prop(value, "id") ?? value);

const statusCounts: ResponseMapper = (raw) =>
  rows(raw).map((row) => ({
    shipping_status: str(row.shipping_status, "UNKNOWN"),
    count: toCount(row.count),
  }));

const counter = (pattern: string): ResponseMapper => {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear().toString()}${(now.getUTCMonth() + 1).toString().padStart(2, "0")}`;
  return (raw) => ({
    counter: str(prop(clean(raw), "number"), "0001"),
    month_key: monthKey,
    pattern,
  });
};

const orderCounter = counter("<entity_id>O<month_key><counter>");
const quotationCounter = counter("Q<entity_id><month_key><counter>");

/**
 * The event endpoint answers HTTP 200 with an ERROR-SHAPED body when the
 * milestone already exists: Pbyp updated the existing row instead of
 * creating a second one. That is a success, and reporting it as a failure
 * makes the agent retry a write that already landed.
 */
const eventWrite: ResponseMapper = (raw) => {
  const errors = arr(prop(raw, "errors"));
  const duplicated = errors.some(
    (error) =>
      prop(prop(error, "extensions"), "code") === "EVENT_ALREADY_EXIST",
  );
  if (duplicated) return { deduplicated: true };
  const value = clean(raw);
  return { id: prop(value, "id"), deduplicated: false };
};

export const pbypMappers: ProviderMappers = {
  request: {
    describeFields,
    queryItems,
    createItems,
    updateItems,
    deleteItems,
    uploadFile,
    whoami: whoamiRequest,
    listProfiles: listProfilesRequest,
    listEvents,
    listEventTypes,
    listGateways,
    countByStatus,
    monthCount,
    createOrder,
    createFolder,
    createSeaBooking,
    createAirBooking,
    createQuotation,
    addEvent,
    setParcels,
    attachOrderToFolder,
    detachOrderFromFolder,
    shareWithEntity,
    revokeShare,
    archiveObject,
    setQuotationStatus,
    transferToGateway,
    assignContainers,
    unassignParcelContainer,
    createGateway,
    updateGateway,
    declareTracking,
    createLtaStock,
    inviteUser,
    createClient,
  },
  response: {
    describeCollection,
    itemsResult,
    writeResult,
    uploadedFile,
    whoami,
    profileList,
    eventList: eventRows,
    eventTypeList: eventTypeRows,
    gatewayList: gatewayRows,
    statusCounts,
    orderCounter,
    quotationCounter,
    eventWrite,
  },
};
