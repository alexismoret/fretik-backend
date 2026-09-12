import { describe, expect, test } from "bun:test";
import { PBYP_SCHEMA } from "../../src/pbyp/directus-schema";
import {
  ARCHIVABLE_COLLECTIONS,
  COMPUTED_FIELDS,
  CREATE_COLLECTIONS,
  DELETE_COLLECTIONS,
  EDI_JOURNALS,
  HUMAN_REFERENCE_FIELDS,
  READ_COLLECTIONS,
  resolveFieldPath,
  SECRET_KEYS,
  SHARE_JUNCTIONS,
  TARGETS,
  UPDATE_COLLECTIONS,
} from "../../src/pbyp/invariants";
import { pbypManifest } from "../../src/pbyp/manifest";
import { DEFAULT_PROJECTIONS } from "../../src/pbyp/projections";

/**
 * Every collection, column and enum value this provider names must still
 * exist in Pbyp.
 *
 * The failure this prevents is not a crash — it is a rename shipping
 * silently. A whitelist entry for a collection that no longer exists is a
 * dead rule; a computed column that was renamed stops being stripped and
 * the agent starts overwriting a derived status again; an enum that gained
 * a value makes an action unable to express it. None of those show up in a
 * typecheck, and all of them reach a user as a wrong answer rather than an
 * error.
 *
 * Refresh the snapshot when Pbyp changes, then fix what this reports:
 *   PBYP_DIRECTUS_URL=… PBYP_ADMIN_TOKEN=… bun run pbyp:schema
 *
 * (The analogous diff between the Shiptify manifest and its OpenAPI spec
 * found nineteen defects the day it was written.)
 */

const fieldsOf = (collection: string): Record<string, unknown> => {
  const def = PBYP_SCHEMA[collection];
  if (def === undefined) throw new Error(`unknown collection: ${collection}`);
  return def.fields;
};

const choicesOf = (collection: string, field: string): string[] | undefined =>
  PBYP_SCHEMA[collection]?.fields[field]?.choices;

describe("collection whitelists", () => {
  test("every listed collection exists", () => {
    const all = new Set([
      ...CREATE_COLLECTIONS,
      ...UPDATE_COLLECTIONS,
      ...DELETE_COLLECTIONS,
      ...ARCHIVABLE_COLLECTIONS,
      ...Object.keys(HUMAN_REFERENCE_FIELDS),
    ]);
    const missing = [...all].filter((name) => PBYP_SCHEMA[name] === undefined);
    expect(missing).toEqual([]);
  });

  test("the read whitelist IS the schema — no collection is unreachable", () => {
    expect([...READ_COLLECTIONS].sort()).toEqual(
      Object.keys(PBYP_SCHEMA).sort(),
    );
  });

  test("nothing is both archivable and deletable", () => {
    const both = [...ARCHIVABLE_COLLECTIONS].filter((name) =>
      DELETE_COLLECTIONS.has(name),
    );
    expect(both).toEqual([]);
  });

  test("a writable collection is readable", () => {
    const orphans = [...CREATE_COLLECTIONS, ...UPDATE_COLLECTIONS].filter(
      (name) => !READ_COLLECTIONS.has(name),
    );
    expect(orphans).toEqual([]);
  });
});

describe("computed columns", () => {
  test("every stripped column exists on its collection", () => {
    const missing: string[] = [];
    for (const [collection, fields] of Object.entries(COMPUTED_FIELDS)) {
      const known = fieldsOf(collection);
      for (const field of fields) {
        if (!(field in known)) missing.push(`${collection}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("every collection with a derived status has it stripped", () => {
    const missing = Object.entries(PBYP_SCHEMA)
      .filter(([, def]) => "shipping_status" in def.fields)
      .map(([name]) => name)
      .filter(
        (name) => !(COMPUTED_FIELDS[name] ?? []).includes("shipping_status"),
      );
    expect(missing).toEqual([]);
  });

  test("every collection with totals has them stripped", () => {
    const missing: string[] = [];
    for (const [name, def] of Object.entries(PBYP_SCHEMA)) {
      for (const field of Object.keys(def.fields)) {
        if (!field.startsWith("total_")) continue;
        if (!(COMPUTED_FIELDS[name] ?? []).includes(field)) {
          missing.push(`${name}.${field}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * A stripped column that is ALSO `NOT NULL` only works because a Pbyp
   * hook fills it before the insert. That is a real dependency on Pbyp's
   * internals, and it is invisible until a hook changes — so each one is
   * listed with the hook that supplies it, and a new one has to be added
   * here deliberately rather than discovered in production.
   */
  const FILLED_BY_A_HOOK: Readonly<Record<string, string>> = {
    "orders.shipping_status": "shipping-status.ts",
    "sea_folders.shipping_status": "shipping-status.ts",
    "air_folders.shipping_status": "shipping-status.ts",
    "sea_bookings.shipping_status": "shipping-status.ts",
    "air_bookings.shipping_status": "shipping-status.ts",
    "containers.shipping_status": "shipping-status.ts",
    "sea_folders.folder_number": "folder-hooks/reference.ts",
    "air_folders.folder_number": "folder-hooks/reference.ts",
    "events.code": "event-hooks/create.ts",
    // FilterUpsertAirBooking derives these from `flights`, on the create
    // FILTER — so they are set before the NOT NULL check runs. This is why
    // `create_air_booking` requires `flights` and declares no route.
    "air_bookings.ETD": "booking-hooks/upsert.ts",
    "air_bookings.ETA": "booking-hooks/upsert.ts",
    "air_bookings.departure_terminal": "booking-hooks/upsert.ts",
    "air_bookings.arrival_terminal": "booking-hooks/upsert.ts",
  };

  test("every stripped NOT NULL column is a documented hook fill", () => {
    const undocumented: string[] = [];
    for (const [collection, fields] of Object.entries(COMPUTED_FIELDS)) {
      const known = PBYP_SCHEMA[collection]?.fields ?? {};
      for (const field of fields) {
        const key = `${collection}.${field}`;
        if (known[field]?.required === true && !(key in FILLED_BY_A_HOOK)) {
          undocumented.push(key);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });

  test("no documented hook fill has stopped being stripped", () => {
    const stale = Object.keys(FILLED_BY_A_HOOK).filter((key) => {
      const [collection, field] = key.split(".");
      if (collection === undefined || field === undefined) return true;
      return !(COMPUTED_FIELDS[collection] ?? []).includes(field);
    });
    expect(stale).toEqual([]);
  });
});

describe("the references the agent reads", () => {
  /**
   * The references must not restate the schema. This is not tidiness — it
   * is the defect that cost a whole conversation on 08/09: `collections.md`
   * called `sea_bookings.companies` an m2m when it is an m2o. Directus
   * ignores an invalid path and returns the raw id rather than an error, so
   * the agent read that as "dot-paths don't work here", queried a junction
   * table that does not exist, then downloaded 379 bookings and 1 264
   * companies to join them by hand. One wrong word, eight tool calls.
   *
   * A hand-written copy of a machine-readable fact drifts; the fix was to
   * stop keeping the copy. `describe_collection` now answers shape from the
   * snapshot, live and per call. These tests fail if the copy comes back.
   */
  const readReference = async (name: string): Promise<string> =>
    Bun.file(`${import.meta.dir}/../../src/pbyp/references/${name}.md`).text();

  test("no reference claims a relation KIND — describe_collection owns that", async () => {
    const claims: string[] = [];
    for (const name of ["collections", "payloads", "access-and-scope"]) {
      const doc = await readReference(name);
      for (const [match] of doc.matchAll(/`[a-z_]+`\s+(?:m2m|o2m|m2o)\b/g)) {
        claims.push(`${name}.md: ${match}`);
      }
    }
    expect(claims).toEqual([]);
  });

  test("collections.md carries no field inventory", async () => {
    // `**R**` / `**C**` marked required and computed columns by hand. Both
    // are now fields of `describe_collection`'s answer.
    const doc = await readReference("collections");
    expect(doc).not.toMatch(/\*\*[RC]\*\*/);
  });

  /**
   * The carrier's document belongs to the VOYAGE, not to the file the
   * forwarder opens. I wrote the opposite — "a folder is a bill of lading
   * at sea, an air waybill in the air" — and it propagated to four places
   * before the domain owner caught it in an answer. The schema said so all
   * along: `sea_folders` has no BL column at all.
   */
  test("the carrier's document lives on the booking, not the folder", () => {
    expect(PBYP_SCHEMA.sea_bookings?.fields.BL_number).toBeDefined();
    expect(PBYP_SCHEMA.air_bookings?.fields.LTA).toBeDefined();
    expect(PBYP_SCHEMA.sea_folders?.fields.BL_number).toBeUndefined();
    expect(PBYP_SCHEMA.air_folders?.fields.LTA).toBeUndefined();
    // And the carrier itself: only bookings name one.
    expect(PBYP_SCHEMA.sea_bookings?.fields.companies?.relation?.to).toBe(
      "oversea_companies",
    );
    expect(PBYP_SCHEMA.sea_folders?.fields.companies).toBeUndefined();
  });

  test("no agent-facing file calls a folder a bill of lading", async () => {
    for (const name of ["collections", "payloads", "status-and-events"]) {
      const doc = await readReference(name);
      expect(doc).not.toMatch(
        /folders?[^.\n]{0,40}(bill of lading|BL \/ AWB)/i,
      );
    }
  });

  test("it still says what the schema cannot", async () => {
    // The counterweight: stripping the inventories must not strip the
    // semantics that justify the file existing at all.
    const doc = await readReference("collections");
    for (const rule of [
      "0-indexed", // the folder_number month trap
      "Only an Agency", // which entity level holds shipments
      "no name column", // a document is identified by its kind and its link
      "access_key", // the partner token is stripped from every response
    ]) {
      expect(doc).toContain(rule);
    }
  });
});

describe("the default projections", () => {
  /**
   * A projection is sent on every `query_items` that names no fields, so a
   * path Pbyp renamed turns the generic read into a 403 for a whole
   * collection. Walking them here is the same trade as the relation-shape
   * check above: the snapshot knows, prose does not.
   */
  test("every path resolves against the schema", () => {
    // The same walker `query_items` uses on the caller's own `fields`, so a
    // projection cannot claim a path the provider would reject.
    const broken: string[] = [];
    for (const [collection, fields] of Object.entries(DEFAULT_PROJECTIONS)) {
      for (const path of fields) {
        const problem = resolveFieldPath(collection, path);
        if (problem !== undefined) broken.push(`${collection}: ${problem}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("none of them asks for a secret", () => {
    // `scrubSecrets` drops these on the way back; asking for one would still
    // put a partner's static token on the wire and in the request log.
    const leaking = Object.entries(DEFAULT_PROJECTIONS).flatMap(
      ([collection, fields]) =>
        fields
          .filter((path) =>
            path.split(".").some((segment) => SECRET_KEYS.has(segment)),
          )
          .map((path) => `${collection}.${path}`),
    );
    expect(leaking).toEqual([]);
  });

  test("every projected collection is readable", () => {
    const unreachable = Object.keys(DEFAULT_PROJECTIONS).filter(
      (name) => !READ_COLLECTIONS.has(name),
    );
    expect(unreachable).toEqual([]);
  });
});

describe("human references", () => {
  test("every reference column exists", () => {
    const missing = Object.entries(HUMAN_REFERENCE_FIELDS).filter(
      ([collection, field]) => !(field in fieldsOf(collection)),
    );
    expect(missing).toEqual([]);
  });
});

describe("domain maps", () => {
  test("every event / share target names a real collection", () => {
    for (const { collection } of Object.values(TARGETS)) {
      expect(PBYP_SCHEMA[collection]).toBeDefined();
    }
  });

  test("an event junction resolves to a real many-to-many on `events`", () => {
    const eventFields = fieldsOf("events");
    for (const [key, { collection, junction }] of Object.entries(TARGETS)) {
      // `quotations` is a share target only — events never hang off one.
      if (key === "quotation") continue;
      const relation = PBYP_SCHEMA.events?.fields[junction]?.relation;
      expect(eventFields[junction]).toBeDefined();
      expect(relation?.kind).toBe("m2m");
      if (relation?.kind === "m2m") {
        expect(relation.otherFk).toBe(`${collection}_id`);
      }
    }
  });

  test("every sharing junction exists with both its columns", () => {
    for (const { table, fk } of Object.values(SHARE_JUNCTIONS)) {
      const fields = fieldsOf(table);
      expect(fields[fk]).toBeDefined();
      expect(fields.entities_id).toBeDefined();
      expect(fields.can_edit).toBeDefined();
    }
  });

  test("every EDI journal exists with its object column and the quadruplet", () => {
    for (const { collection, column } of Object.values(EDI_JOURNALS)) {
      const fields = fieldsOf(collection);
      expect(fields[column]).toBeDefined();
      for (const flag of [
        "gateway_external_id",
        "is_pbyp_export",
        "is_updated",
        "receive_validation",
      ]) {
        expect(fields[flag]).toBeDefined();
      }
    }
  });
});

describe("manifest enums", () => {
  /**
   * Enum params whose values are a Pbyp dropdown. A value we allow that
   * Pbyp does not is a 400 the agent cannot diagnose; a value Pbyp allows
   * that we do not is a request the user cannot express.
   */
  const PINNED: [
    action: string,
    param: string,
    collection: string,
    field: string,
  ][] = [
    ["create_order", "incoterm", "orders", "incoterm"],
    ["create_folder", "folder_type", "sea_folders", "folder_type"],
    ["create_folder", "incoterm", "sea_folders", "incoterm"],
    ["create_quotation", "incoterm", "quotations", "incoterm"],
    ["create_quotation", "booking_type", "quotations", "booking_type"],
    [
      "set_quotation_status",
      "quotation_status",
      "quotations",
      "quotation_status",
    ],
  ];

  // `shipping_status` used to be pinned here through the four typed
  // searches. It is deliberately absent now: with those actions gone and
  // the value lists stripped out of the references, the schema is the only
  // place the statuses are written down — `describe_collection` reads them
  // live. Nothing duplicates them, so there is nothing left to drift.

  test.each(PINNED)(
    "%s.%s matches %s.%s",
    (actionName, param, collection, field) => {
      const found = pbypManifest.actions.find((a) => a.name === actionName);
      expect(found).toBeDefined();
      const declared = found?.params[param]?.values;
      expect(declared).toBeDefined();
      expect([...(declared ?? [])].sort()).toEqual(
        [...(choicesOf(collection, field) ?? [])].sort(),
      );
    },
  );

  test("container types and shipping methods match the schema", () => {
    const containers = pbypManifest.actions.find(
      (a) => a.name === "create_sea_booking",
    )?.params.containers?.items?.fields;
    expect([...(containers?.type?.values ?? [])].sort()).toEqual(
      [...(choicesOf("containers", "type") ?? [])].sort(),
    );
    expect([...(containers?.shipping_method?.values ?? [])].sort()).toEqual(
      [...(choicesOf("containers", "shipping_method") ?? [])].sort(),
    );
  });

  test("the module enum matches the transport column", () => {
    expect(
      [
        ...(pbypManifest.actions.find((a) => a.name === "create_folder")?.params
          .module?.values ?? []),
      ].sort(),
    ).toEqual([...(choicesOf("orders", "transport_type") ?? [])].sort());
  });

  test("the currency enum matches", () => {
    expect(
      [
        ...(pbypManifest.actions.find((a) => a.name === "create_order")?.params
          .parcels_price_currency?.values ?? []),
      ].sort(),
    ).toEqual(
      [...(choicesOf("orders", "parcels_price_currency") ?? [])].sort(),
    );
  });

  test("container_link_type matches", () => {
    const items = pbypManifest.actions.find(
      (a) => a.name === "assign_containers",
    )?.params.items?.items?.fields;
    expect([...(items?.container_link_type?.values ?? [])].sort()).toEqual(
      [...(choicesOf("orders", "container_link_type") ?? [])].sort(),
    );
  });
});

describe("required columns the typed creates must cover", () => {
  /**
   * A NOT NULL column with no default, absent from the action, makes the
   * action impossible to satisfy — the failure Shiptify's date filters had.
   * Columns Pbyp fills itself are listed as exceptions, with why.
   */
  const FILLED_BY_PBYP: Readonly<Record<string, readonly string[]>> = {
    // Composed by the folder hook, derived from the events, or filled from
    // `entity_id` — see the hook map above. `client` / `freight_forwarder`
    // are the two sides of a quotation; the hook writes the caller's own.
    sea_folders: ["folder_number", "shipping_status"],
    air_folders: ["folder_number", "shipping_status"],
    orders: ["shipping_status"],
    sea_bookings: ["shipping_status"],
    air_bookings: [
      "shipping_status",
      "ETD",
      "ETA",
      "departure_terminal",
      "arrival_terminal",
    ],
    quotations: ["quotation_status", "client", "freight_forwarder"],
    events: ["code", "source"],
  };

  const COVERED: [collection: string, action: string, params: string[]][] = [
    [
      "orders",
      "create_order",
      ["number", "date", "incoterm", "entity_id", "shipper", "consignee"],
    ],
    [
      "sea_folders",
      "create_folder",
      ["folder_type", "date", "incoterm", "entity_id", "shipper", "consignee"],
    ],
    [
      "sea_bookings",
      "create_sea_booking",
      [
        "booking_number",
        "entity_id",
        "booking_type",
        "departure_terminal",
        "arrival_terminal",
        "ETD",
        "ETA",
      ],
    ],
    [
      "air_bookings",
      "create_air_booking",
      ["booking_number", "entity_id", "booking_type", "LTA"],
    ],
    [
      "quotations",
      "create_quotation",
      [
        "number",
        "entity_id",
        "transport_type",
        "booking_type",
        "incoterm",
        "margin",
        "shipper",
        "consignee",
        "departure_terminal",
        "arrival_terminal",
        "etd",
        "eta",
      ],
    ],
  ];

  test.each(COVERED)(
    "every required column of %s is a parameter of %s",
    (collection, _action, params) => {
      const def = PBYP_SCHEMA[collection];
      if (def === undefined)
        throw new Error(`unknown collection: ${collection}`);
      const required = Object.entries(def.fields)
        .filter(([, spec]) => spec.required === true)
        .map(([name]) => name)
        .filter((name) => !(FILLED_BY_PBYP[collection] ?? []).includes(name));
      const uncovered = required.filter((name) => !params.includes(name));
      expect(uncovered).toEqual([]);
    },
  );

  test.each(COVERED)(
    "%s's required parameters are declared on %s",
    (_collection, actionName, params) => {
      const found = pbypManifest.actions.find((a) => a.name === actionName);
      expect(found).toBeDefined();
      const optional = params.filter(
        (name) => found?.params[name]?.optional === true,
      );
      expect(optional).toEqual([]);
    },
  );
});
