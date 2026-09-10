import { prop } from "@fretik/shared/external-apps/json-access";
import type { ResolvedAction } from "@fretik/shared/external-apps/registry";
import { buildRequest } from "@fretik/shared/services/external-apps/exec/build-request";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { describe, expect, test } from "bun:test";
import { pbypManifest, pbypMappers } from "../../src/pbyp";

/**
 * What Pbyp accepts and quietly gets wrong.
 *
 * Every case here is a payload Directus or the Pbyp bundle answers 2xx to
 * while doing something other than what was meant — a many-to-many written
 * as bare ids relinking unrelated rows, a computed status that survives
 * until the next hook run, an event with no junction, an EDI journal row
 * missing the quadruplet that makes a partner collect it. A 400 is not the
 * risk; a success that is wrong is.
 *
 * Each assertion runs the args through the SAME validator and request
 * builder the dispatcher uses, so what is pinned is the wire shape.
 */

const action = (name: string) => {
  const found = pbypManifest.actions.find((a) => a.name === name);
  if (found === undefined) throw new Error(`no such action: ${name}`);
  return found;
};

const resolve = (name: string): ResolvedAction => {
  const found = action(name);
  const mapperKey = found.request;
  return {
    providerKey: "pbyp",
    manifest: pbypManifest,
    transport: pbypManifest.transport,
    action: found,
    ...(mapperKey !== undefined
      ? { requestMapper: pbypMappers.request?.[mapperKey] }
      : {}),
  };
};

const send = (name: string, args: Record<string, unknown>) =>
  buildRequest(resolve(name), validateActionArgs(name, action(name), args));

const bodyOf = (name: string, args: Record<string, unknown>) => {
  const built = send(name, args);
  if (!Array.isArray(built.body) && typeof built.body !== "object") {
    throw new Error(`${name} produced no object body`);
  }
  return built.body;
};

describe("describing a collection", () => {
  const reply = (rows: Record<string, unknown>[], asked: string[]): unknown =>
    pbypMappers.response?.describeCollection?.(
      { data: rows },
      { collections: asked },
    );

  test("one row per column, each naming its own collection", () => {
    // Measured 09/09: the agent wrote `for d in docs: for f in d`, expecting
    // one object per collection. The shape is flat and each row carries
    // `collection` — the summary and the guidance now say so, and this pins
    // the behaviour they describe.
    const out = reply(
      [
        { collection: "orders", field: "number", type: "string" },
        { collection: "orders", field: "parcels", type: "alias" },
        { collection: "terminals", field: "name", type: "string" },
        { collection: "events", field: "code", type: "string" },
      ],
      ["orders", "terminals"],
    );
    expect(Array.isArray(out)).toBe(true);
    const rows = Array.isArray(out) ? out : [];
    // The collection not asked for is dropped; the two asked for are kept.
    expect(rows.map((r) => prop(r, "collection"))).toEqual([
      "orders",
      "orders",
      "terminals",
    ]);
  });

  test("a link carries the path to write, a m2m through its junction key", () => {
    const rows = reply(
      [
        { collection: "orders", field: "parcels", type: "alias" },
        { collection: "orders", field: "consignee", type: "integer" },
      ],
      ["orders"],
    );
    const list = Array.isArray(rows) ? rows : [];
    expect(prop(list[0], "path")).toBe("parcels.parcels_id");
    expect(prop(list[1], "path")).toBe("consignee");
    expect(prop(list[1], "links_to")).toBe("address");
  });

  test("a hook-owned column is flagged so it is never sent", () => {
    const rows = reply(
      [{ collection: "orders", field: "shipping_status", type: "string" }],
      ["orders"],
    );
    expect(prop(Array.isArray(rows) ? rows[0] : undefined, "computed")).toBe(
      true,
    );
  });

  test("a field name mistaken for a collection is answered with the real one", () => {
    // `companies` is a column of sea_bookings; the table is
    // `oversea_companies`. Naming it costs one line and saves a round-trip.
    expect(() =>
      send("describe_collection", { collections: ["companies"] }),
    ).toThrow(/oversea_companies/);
  });

  test("more than five collections is refused before the call", () => {
    expect(() =>
      send("describe_collection", {
        collections: [
          "orders",
          "events",
          "parcels",
          "containers",
          "files",
          "terminals",
        ],
      }),
    ).toThrow(/at most 5/);
  });
});

describe("relation shapes", () => {
  test("a many-to-many written as bare ids is refused before the call", () => {
    // Directus reads [41, 42] as ids of `orders_parcels` rows and links
    // two unrelated parcels, reporting success.
    expect(() =>
      send("create_items", {
        collection: "orders",
        items: [{ number: "X", parcels: [41, 42] }],
      }),
    ).toThrow(/parcels_id/);
  });

  test("the junction shape passes", () => {
    const body = bodyOf("create_items", {
      collection: "orders",
      items: [{ number: "X", parcels: [{ parcels_id: 41 }] }],
    });
    expect(body).toEqual([{ number: "X", parcels: [{ parcels_id: 41 }] }]);
  });

  test("a many-to-one accepts an id or a nested create", () => {
    expect(() =>
      send("create_items", {
        collection: "orders",
        items: [{ shipper: 412 }, { shipper: { name: "ACME" } }],
      }),
    ).not.toThrow();
  });
});

describe("computed columns", () => {
  test("create strips them and keeps the rest", () => {
    const body = bodyOf("create_items", {
      collection: "orders",
      items: [
        {
          number: "3O2026090007",
          shipping_status: "IN_TRANSIT",
          co2: 12,
          total_weight: 37,
        },
      ],
    });
    expect(body).toEqual([{ number: "3O2026090007" }]);
  });

  test("update strips entity_id too — the ownership guard refuses it", () => {
    const built = send("update_items", {
      collection: "orders",
      ids: [7],
      data: { client_reference: "PO-1", entity_id: 3, shipping_status: "X" },
    });
    expect(built.body).toEqual({
      keys: [7],
      data: { client_reference: "PO-1" },
    });
  });

  test("an update left empty by stripping is refused, not sent", () => {
    expect(() =>
      send("update_items", {
        collection: "orders",
        ids: [7],
        data: { shipping_status: "DELIVERED" },
      }),
    ).toThrow();
  });

  test("a typed create strips them as well", () => {
    const body = bodyOf("create_order", {
      module: "sea",
      number: "3O2026090007",
      date: "2026-09-08",
      incoterm: "FOB",
      entity_id: 3,
      shipper: { id: 1 },
      consignee: { id: 2 },
    });
    expect(body).not.toHaveProperty("shipping_status");
    expect(body).toMatchObject({ transport_type: "sea", shipper: 1 });
  });
});

describe("collection whitelists", () => {
  test("deleting an order points at archive instead", () => {
    expect(() =>
      send("delete_items", { collection: "orders", ids: [7] }),
    ).toThrow(/archive/);
  });

  test("deleting a junction row is allowed", () => {
    const built = send("delete_items", {
      collection: "orders_parcels",
      ids: [7],
    });
    expect(built.endpoint).toBe("/items/orders_parcels");
    expect(built.body).toEqual([7]);
  });

  test("creating a gateway through /items points at the endpoint", () => {
    expect(() =>
      send("create_items", { collection: "gateway_external", items: [{}] }),
    ).toThrow(/create_gateway/);
  });

  test("an unknown collection is named as such", () => {
    expect(() => send("query_items", { collection: "shipments" })).toThrow(
      /not a Pbyp collection/,
    );
  });

  test("reference data cannot be written", () => {
    expect(() =>
      send("create_items", { collection: "terminals", items: [{ name: "X" }] }),
    ).toThrow(/reference data/);
  });
});

describe("events", () => {
  test("exactly one junction is built, and `code` is never sent", () => {
    const body = bodyOf("add_event", {
      target_type: "sea_folder",
      target_id: 88,
      event_type_id: 1,
      date: "2026-09-07T08:00:00Z",
      actual: true,
    });
    expect(body).toEqual({
      type: 1,
      date: "2026-09-07T08:00:00Z",
      actual: true,
      source: "user",
      sea_folders: [{ sea_folders_id: 88 }],
    });
  });

  test("a future date defaults to a forecast", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const body = bodyOf("add_event", {
      target_type: "order",
      target_id: 1,
      event_type_id: 2,
      date: future,
    });
    expect(body).toMatchObject({ actual: false, orders: [{ orders_id: 1 }] });
  });

  test("deduplication is reported as a success, not an error", () => {
    const mapper = pbypMappers.response?.eventWrite;
    if (mapper === undefined) throw new Error("eventWrite mapper missing");
    expect(
      mapper({
        errors: [{ extensions: { code: "EVENT_ALREADY_EXIST" } }],
      }),
    ).toEqual({ deduplicated: true });
  });
});

describe("EDI transfer", () => {
  test("the journal row carries the quadruplet a partner pull filters on", () => {
    const built = send("transfer_to_gateway", {
      object: "sea_folder",
      object_id: 88,
      gateway_id: 7,
    });
    expect(built.endpoint).toBe("/items/folder_edi");
    expect(built.body).toEqual({
      sea_folder_id: 88,
      gateway_external_id: 7,
      is_pbyp_export: true,
      is_updated: false,
      receive_validation: false,
    });
  });

  test("each object family lands in its own journal and column", () => {
    expect(
      send("transfer_to_gateway", {
        object: "air_booking",
        object_id: 3,
        gateway_id: 7,
      }).body,
    ).toMatchObject({ air_booking_id: 3 });
    expect(
      send("transfer_to_gateway", {
        object: "order",
        object_id: 3,
        gateway_id: 7,
      }).endpoint,
    ).toBe("/items/orders_edi");
  });

  test("external_reference belongs to an event transfer only", () => {
    expect(() =>
      send("transfer_to_gateway", {
        object: "order",
        object_id: 3,
        gateway_id: 7,
        external_reference: "X",
      }),
    ).toThrow(/external_references/);
  });
});

describe("value formats", () => {
  test("a container number is checked against ISO 6346", () => {
    expect(() =>
      send("create_sea_booking", {
        booking_number: "BK-1",
        entity_id: 3,
        booking_type: "export",
        departure_terminal: 3,
        arrival_terminal: 9,
        ETD: "2026-09-20T00:00:00Z",
        ETA: "2026-10-18T00:00:00Z",
        containers: [{ number: "MSCU1234567", type: "40HC" }],
      }),
    ).toThrow(/ISO 6346/);
  });

  test("Pbyp's own placeholder is accepted", () => {
    const body = bodyOf("create_sea_booking", {
      booking_number: "BK-1",
      entity_id: 3,
      booking_type: "export",
      departure_terminal: 3,
      arrival_terminal: 9,
      ETD: "2026-09-20T00:00:00Z",
      ETA: "2026-10-18T00:00:00Z",
      containers: [{ number: "TMPU0000003", type: "40HC" }],
    });
    expect(body).toMatchObject({
      containers: [{ number: "TMPU0000003", type: "40HC" }],
    });
  });

  test("an invalid air waybill is refused", () => {
    expect(() =>
      send("create_air_booking", {
        booking_number: "AB-1",
        entity_id: 3,
        booking_type: "export",
        LTA: "057-12345671",
        flights: [
          {
            pol: 1,
            pod: 2,
            etd: "2026-09-21T21:40:00Z",
            eta: "2026-09-22T06:10:00Z",
          },
        ],
      }),
    ).toThrow(/air waybill/);
  });

  test("a day where an instant is declared is refused by the validator", () => {
    expect(() =>
      send("add_event", {
        target_type: "order",
        target_id: 1,
        event_type_id: 1,
        date: "2026-09-07",
      }),
    ).toThrow();
  });

  test("an instant where a day is declared is refused too", () => {
    expect(() =>
      send("create_order", {
        module: "sea",
        number: "N",
        date: "2026-09-07T08:00:00Z",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { id: 1 },
        consignee: { id: 2 },
      }),
    ).toThrow();
  });
});

describe("conditional rules", () => {
  test("a house folder must name its master", () => {
    expect(() =>
      send("create_folder", {
        module: "sea",
        folder_type: "house",
        date: "2026-09-08",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { id: 1 },
        consignee: { id: 2 },
        payer_id: 4,
      }),
    ).toThrow(/master_id/);
  });

  test("a single folder must name its payer", () => {
    expect(() =>
      send("create_folder", {
        module: "sea",
        folder_type: "single",
        date: "2026-09-08",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { id: 1 },
        consignee: { id: 2 },
      }),
    ).toThrow(/payer_id/);
  });

  test("a master folder needs no payer", () => {
    expect(() =>
      send("create_folder", {
        module: "air",
        folder_type: "master",
        date: "2026-09-08",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { id: 1 },
        consignee: { id: 2 },
      }),
    ).not.toThrow();
  });

  test("a sea booking takes a listed carrier or a free-text one, never both", () => {
    expect(() =>
      send("create_sea_booking", {
        booking_number: "BK-1",
        entity_id: 3,
        booking_type: "export",
        departure_terminal: 3,
        arrival_terminal: 9,
        ETD: "2026-09-20T00:00:00Z",
        ETA: "2026-10-18T00:00:00Z",
        company_id: 12,
        custom_company: "Some line",
      }),
    ).toThrow(/not both/);
  });

  test("an address needs a country, in one form or the other", () => {
    expect(() =>
      send("create_order", {
        module: "sea",
        number: "X",
        date: "2026-09-08",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { name: "ACME", code: "ACME" },
        consignee: { id: 2 },
      }),
    ).toThrow(/country_id/);
  });
});

describe("module routing", () => {
  test("folders and bookings hit their module's collection", () => {
    expect(
      send("create_folder", {
        module: "air",
        folder_type: "single",
        date: "2026-01-01",
        incoterm: "FOB",
        entity_id: 3,
        shipper: { id: 1 },
        consignee: { id: 2 },
        payer_id: 3,
      }).endpoint,
    ).toBe("/items/air_folders");
    expect(
      send("create_sea_booking", {
        booking_number: "B1",
        entity_id: 3,
        booking_type: "import",
        departure_terminal: 1,
        arrival_terminal: 2,
        ETD: "2026-01-01T00:00:00Z",
        ETA: "2026-01-02T00:00:00Z",
      }).endpoint,
    ).toBe("/items/sea_bookings");
  });

  test("orders carry the module on the row instead", () => {
    const built = send("create_order", {
      module: "air",
      number: "N",
      date: "2026-01-01",
      incoterm: "FOB",
      entity_id: 3,
      shipper: { id: 1 },
      consignee: { id: 2 },
    });
    expect(built.endpoint).toBe("/items/orders");
    expect(built.body).toMatchObject({ transport_type: "air" });
  });

  test("an order attaches through its module's junction", () => {
    const built = send("attach_order_to_folder", {
      module: "air",
      order_id: 5,
      folder_id: 9,
    });
    expect(built.endpoint).toBe("/items/air_folders_orders");
    expect(built.body).toEqual({ orders_id: 5, air_folders_id: 9 });
  });
});

describe("reads", () => {
  /**
   * Pbyp cancels by archiving. When the four typed searches went, their
   * `status: published` clause had to land somewhere or every count would
   * quietly start including cancelled shipments — the kind of wrong answer
   * that reads as correct.
   */
  test("reads exclude archived rows unless asked", () => {
    expect(
      send("query_items", { collection: "orders" }).query?.filter,
    ).toContain("published");
    expect(
      send("query_items", { collection: "orders", include_archived: true })
        .query?.filter,
    ).toBeUndefined();
  });

  /**
   * Both measured live on 09/09, both now answered before the request
   * leaves. The third is the one that mattered: `air_folders.id` on an
   * order is the JUNCTION row's id, Directus returns it without an error,
   * and the agent built a whole conclusion on the wrong records.
   */
  test("a bad field path is named, not sent", () => {
    // Was a 403 reading as a permission problem.
    expect(() =>
      send("query_items", {
        collection: "air_folders",
        fields: ["air_folders_id"],
      }),
    ).toThrow(/has no column "air_folders_id"/);

    // Was a plausible wrong answer.
    expect(() =>
      send("query_items", { collection: "orders", fields: ["air_folders.id"] }),
    ).toThrow(/air_folders\.air_folders_id/);
  });

  test("grouping through a relation is refused with the alternative", () => {
    // Was a bare Directus 500.
    expect(() =>
      send("query_items", {
        collection: "orders",
        aggregate: { count: "id" },
        group_by: ["shipper.name"],
      }),
    ).toThrow(/Group on "shipper"/);
  });

  test("wildcards, functions and deep paths still pass", () => {
    expect(() =>
      send("query_items", {
        collection: "air_folders",
        fields: [
          "*",
          "count(id)",
          "voyage_id.arrival_terminal.name",
          "consignee.country_id.name",
          "orders.orders_id.number",
        ],
      }),
    ).not.toThrow();
  });

  test("a caller who filters on status owns the question", () => {
    const filter = send("query_items", {
      collection: "orders",
      filter: { status: { _eq: "archived" } },
    }).query?.filter;
    expect(filter).toContain("archived");
    expect(filter).not.toContain("published");
  });

  test("a collection with no archive state gets no status clause", () => {
    expect(
      send("query_items", { collection: "terminals" }).query?.filter,
    ).toBeUndefined();
  });

  /**
   * Directus applies `limit` to the number of GROUPS, so the default of 25
   * would silently answer "which carrier is used most" with the first 25
   * carriers. Measured: 17 groups over 379 bookings — under the cap today,
   * which is exactly why this must be pinned rather than noticed.
   */
  test("an aggregate asks for every group, explicitly", () => {
    // Omitting `limit` does NOT lift the cap — Directus falls back to 100.
    // Measured: 485 folders grouped by voyage give 100 groups with no
    // limit and 325 with `-1`. A truncated count reads as a right answer.
    const built = send("query_items", {
      collection: "sea_folders",
      aggregate: { count: "id" },
      group_by: ["voyage_id"],
    });
    expect(built.query?.limit).toBe("-1");
    expect(built.query?.page).toBeUndefined();
    expect(built.query?.groupBy).toBe("voyage_id");
  });

  test("a caller's limit never narrows an aggregate", () => {
    expect(
      send("query_items", {
        collection: "orders",
        aggregate: { count: "id" },
        limit: 25,
      }).query?.limit,
    ).toBe("-1");
  });

  test("-1 reads every row and drops the meaningless page", () => {
    const built = send("query_items", { collection: "orders", limit: -1 });
    expect(built.query?.limit).toBe("-1");
    expect(built.query?.page).toBeUndefined();
    expect(() =>
      send("query_items", { collection: "orders", limit: 0 }),
    ).toThrow(/use -1/);
  });

  test("the curated projection resolves links to names, and an explicit fields wins", () => {
    // Without this the first exploratory read hands back `companies: 1198`
    // and the agent cannot tell a company id from a junction row id.
    expect(
      send("query_items", { collection: "sea_bookings" }).query?.fields,
    ).toContain("companies.name");
    expect(
      send("query_items", {
        collection: "sea_bookings",
        fields: ["id"],
      }).query?.fields,
    ).toBe("id");
  });

  test("no default projection fights an aggregate or a deep clause", () => {
    // Directus refuses `fields` beside `aggregate`; and a `deep` clause on a
    // relation the projection does not select is a silent no-op.
    expect(
      send("query_items", {
        collection: "orders",
        aggregate: { count: "id" },
      }).query?.fields,
    ).toBeUndefined();
    expect(
      send("query_items", {
        collection: "sea_folders",
        deep: { events: { _limit: 5 } },
      }).query?.fields,
    ).toBeUndefined();
  });

  test("the gateway list never asks for the partner's static token", () => {
    const built = send("list_gateways", {});
    expect(built.query?.fields).not.toContain("access_key");
  });

  test("a response carrying a secret is scrubbed at any depth", () => {
    const mapper = pbypMappers.response?.gatewayList;
    if (mapper === undefined) throw new Error("gatewayList mapper missing");
    const rendered = JSON.stringify(
      mapper({ data: [{ id: 1, external_code: "NTE", access_key: "s3cr3t" }] }),
    );
    expect(rendered).not.toContain("s3cr3t");
  });

  test("a page is 200 rows at most, or all of them with -1", () => {
    // `-1` is Directus' own "every row" and it works here; a big guess like
    // 5000 does not, and used to be what an agent reached for instead.
    expect(() =>
      send("query_items", { collection: "orders", limit: 5000 }),
    ).toThrow();
    expect(
      send("query_items", { collection: "orders", limit: 200 }).query?.limit,
    ).toBe("200");
  });
});

describe("bundle endpoints", () => {
  test("assign_containers sends an array and the scope's own link key", () => {
    const built = send("assign_containers", {
      scope: "order",
      items: [{ id: 5, container_link_type: "full", container_id: 9 }],
    });
    expect(built.endpoint).toBe("/order-endpoints/assign_containers");
    expect(built.body).toEqual([
      { id: 5, order_container_type: "full", container_id: 9 },
    ]);
  });

  test("a dispatched stuffing without lines is refused", () => {
    expect(() =>
      send("assign_containers", {
        scope: "folder",
        items: [{ id: 5, container_link_type: "dispatched" }],
      }),
    ).toThrow(/parcels/);
  });

  test("the bundle's camelCase payloads are built for it", () => {
    expect(
      send("create_gateway", {
        gateway_type: 1,
        external_code: "NTE",
        entity_id: 3,
      }).body,
    ).toEqual({ gatewayType: "1", externalCode: "NTE", entityId: 3 });
    expect(
      send("create_lta_stock", {
        first_awb: "12345675",
        last_awb: "12345682",
        airline_company: 4,
        entity_id: 3,
      }).body,
    ).toEqual({
      firstAwb: "12345675",
      lastAwb: "12345682",
      airlineCompany: 4,
      entity_id: 3,
    });
  });
});

describe("cargo", () => {
  test("the taxable weight follows the module when it is omitted", () => {
    const sea = bodyOf("set_parcels", {
      target_type: "sea_folder",
      target_id: 1,
      parcels: [{ type: "Carton", quantity: 1, weight: 10, volume: 2 }],
    });
    const air = bodyOf("set_parcels", {
      target_type: "air_folder",
      target_id: 1,
      parcels: [{ type: "Carton", quantity: 1, weight: 10, volume: 2 }],
    });
    expect(JSON.stringify(sea)).toContain('"taxable_weight":2000');
    expect(JSON.stringify(air)).toContain('"taxable_weight":334');
  });

  test("a declared taxable weight is left alone", () => {
    const body = bodyOf("set_parcels", {
      target_type: "order",
      target_id: 1,
      parcels: [
        {
          type: "Carton",
          quantity: 1,
          weight: 10,
          volume: 2,
          taxable_weight: 12,
        },
      ],
    });
    expect(JSON.stringify(body)).toContain('"taxable_weight":12');
  });
});

/**
 * Each of these was green in the unit suite and WRONG against the running
 * preprod. They are the reason the provider ships with a live read pass as
 * well as a wire pass — a shape can be well-formed and still not be what
 * Directus answers to.
 */
describe("filing a document", () => {
  const upload = (args: Record<string, unknown>) => {
    const built = send("upload_file", args);
    if (built.multipart === undefined) {
      throw new Error("upload_file produced no multipart body");
    }
    return built.multipart;
  };

  const PDF = "JVBERi0xLjQK"; // "%PDF-1.4\n"

  test("the bytes go out as multipart, never as a JSON body", () => {
    // The whole reason this action exists: `http-direct` used to stamp
    // `Content-Type: application/json` on every body, and Directus stores a
    // file from a multipart part and from nothing else.
    const built = send("upload_file", {
      filename: "BL.pdf",
      content_base64: PDF,
    });
    expect(built.method).toBe("POST");
    expect(built.endpoint).toBe("/files");
    expect(built.body).toBeUndefined();
    expect(built.multipart?.file).toEqual({
      field: "file",
      filename: "BL.pdf",
      contentType: "application/pdf",
      base64: PDF,
    });
  });

  test("the type is derived from the extension, and an explicit one wins", () => {
    expect(
      upload({ filename: "manifest.xlsx", content_base64: PDF }).file
        .contentType,
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(
      upload({
        filename: "scan",
        content_base64: PDF,
        content_type: "image/tiff",
      }).file.contentType,
    ).toBe("image/tiff");
  });

  test("the title carries the real name, not Directus' prettified guess", () => {
    // Left to itself Directus titles the row "Bl Cma 2026 001".
    expect(
      upload({ filename: "BL-CMA-2026-001.pdf", content_base64: PDF }).fields,
    ).toEqual({ title: "BL-CMA-2026-001.pdf" });
  });

  test("content that is not base64 is refused before the upload", () => {
    // `Buffer.from` DROPS characters it cannot decode instead of throwing,
    // so a data: prefix would upload a truncated file that opens as garbage
    // and reports 200.
    expect(() =>
      upload({
        filename: "BL.pdf",
        content_base64: "data:application/pdf;base64,JVBERi0=",
      }),
    ).toThrow(/valid base64/);
    expect(() => upload({ filename: "BL.pdf", content_base64: "" })).toThrow(
      /b64encode/,
    );
  });

  test("whitespace in the encoding is tolerated", () => {
    // `base64.encodebytes` wraps at 76 columns; `b64encode` does not.
    expect(
      upload({ filename: "BL.pdf", content_base64: "JVBERi0\nxLjQK\n" }).file
        .base64,
    ).toBe(PDF);
  });

  test("a filename is a name, not a path", () => {
    expect(() =>
      upload({ filename: "/workspace/BL.pdf", content_base64: PDF }),
    ).toThrow(/not a path/);
  });

  test("a file too large fails here, not after the upload", () => {
    // 4 base64 chars per 3 bytes — 28 MB of payload.
    expect(() =>
      upload({ filename: "scan.pdf", content_base64: "A".repeat(40_000_000) }),
    ).toThrow(/the limit is 20 MB/);
  });

  test("filesize comes back as a string, like every Postgres bigint", () => {
    const mapper = pbypMappers.response?.uploadedFile;
    if (mapper === undefined) throw new Error("uploadedFile mapper missing");
    expect(
      mapper({
        data: {
          id: "76267c73-059c-46da-8fe0-66f4afa3de1d",
          filename_download: "BL.pdf",
          type: "application/pdf",
          filesize: "8421",
          storage: "s3",
        },
      }),
    ).toEqual({
      id: "76267c73-059c-46da-8fe0-66f4afa3de1d",
      filename_download: "BL.pdf",
      type: "application/pdf",
      filesize: 8421,
    });
  });

  test("the link is one ordinary create — junction and register row together", () => {
    // Measured on preprod: `agency_owner` is required and Directus rejects
    // the nested create without it, so the GED needs no typed action of its
    // own — only the uuid the upload returns.
    for (const [junction, key] of [
      ["orders_files", "orders_id"],
      ["sea_folders_files", "sea_folders_id"],
      ["air_folders_files", "air_folders_id"],
    ] as const) {
      const body = bodyOf("create_items", {
        collection: junction,
        items: [
          {
            [key]: 810,
            files_id: {
              file: "76267c73-059c-46da-8fe0-66f4afa3de1d",
              agency_owner: 41,
              tags: "others",
              status: "published",
            },
          },
        ],
      });
      const row = Array.isArray(body) ? body[0] : undefined;
      expect(prop(row, key)).toBe(810);
      expect(prop(prop(row, "files_id"), "agency_owner")).toBe(41);
    }
  });
});

describe("what only preprod showed", () => {
  test("list_profiles scopes to the caller", () => {
    // Unfiltered, it answered with other accounts' profiles.
    const filter = send("list_profiles", {}).query?.filter;
    expect(filter).toContain("user_id");
    expect(filter).toContain("$CURRENT_USER");
  });

  test("event types are not filtered server-side — Directus refuses it", () => {
    // `400 "json field type does not contain the _contains filter operator"`.
    const built = send("list_event_types", { module: "sea" });
    expect(built.query?.filter).toBeUndefined();
  });

  test("...so the response mapper narrows them instead", () => {
    const request = pbypMappers.request?.listEventTypes;
    const response = pbypMappers.response?.eventTypeList;
    if (request === undefined || response === undefined) {
      throw new Error("event type mappers missing");
    }
    request({ module: "sea", category: "container" });
    const rows = response({
      data: [
        {
          id: 24,
          code: "GATE_IN_AT_POL",
          modules: ["sea"],
          category: ["container"],
        },
        {
          id: 1,
          code: "PICKED_UP",
          modules: ["sea", "air"],
          category: ["folder"],
        },
        {
          id: 8,
          code: "PLANE_DEPARTURE",
          modules: ["air"],
          category: ["booking"],
        },
      ],
    });
    expect(Array.isArray(rows) ? rows.map((r) => prop(r, "code")) : []).toEqual(
      ["GATE_IN_AT_POL"],
    );
  });

  test("an aggregate count arrives as a nested string, not a number", () => {
    // Postgres bigint → JSON string. Reading it as a number gave 0 for
    // every status, with no error anywhere.
    const mapper = pbypMappers.response?.statusCounts;
    if (mapper === undefined) throw new Error("statusCounts mapper missing");
    expect(
      mapper({
        data: [
          { shipping_status: "IN_TRANSIT", count: { id: "53" } },
          { shipping_status: "DELIVERED", count: { id: "69" } },
        ],
      }),
    ).toEqual([
      { shipping_status: "IN_TRANSIT", count: 53 },
      { shipping_status: "DELIVERED", count: 69 },
    ]);
  });
});
