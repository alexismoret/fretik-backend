import type { ResolvedAction } from "@fretik/shared/external-apps/registry";
import { buildRequest } from "@fretik/shared/services/external-apps/exec/build-request";
import { validateActionArgs } from "@fretik/shared/services/external-apps/exec/validate-args";
import { describe, expect, test } from "bun:test";
import { shiptifyManifest, shiptifyMappers } from "../../src/shiptify";

/**
 * The three ways a Shiptify call used to fail without failing loudly, each
 * observed on a real account:
 *
 *  - the date filters were declared `datetime`, so the only values our
 *    validator accepted were the ones Shiptify answered `400 "must respect
 *    format YYYY-MM-DD"` to — the parameter had no satisfiable value;
 *  - `attachments` items declared no fields, so the file was stripped and
 *    Shiptify received `[{}]`;
 *  - `galaxy_update_tracking_point_location` sent a flat object where the
 *    route takes an array of `{code, location}`, keyed on a
 *    `tracking_point_id` that is not part of the API.
 *
 * These pin the wire shape, not the manifest text: each assertion runs the
 * args through the same validator + request builder the dispatcher uses.
 */

const action = (name: string) => {
  const found = shiptifyManifest.actions.find((a) => a.name === name);
  if (found === undefined) throw new Error(`no such action: ${name}`);
  return found;
};

const resolve = (name: string): ResolvedAction => {
  const found = action(name);
  const mapperKey = found.request;
  return {
    providerKey: "shiptify",
    manifest: shiptifyManifest,
    transport: shiptifyManifest.transport,
    action: found,
    ...(mapperKey !== undefined
      ? { requestMapper: shiptifyMappers.request?.[mapperKey] }
      : {}),
  };
};

const send = (name: string, args: Record<string, unknown>) =>
  buildRequest(resolve(name), validateActionArgs(name, action(name), args));

describe("date filters", () => {
  test("both shipment lists accept the calendar day Shiptify demands", () => {
    for (const name of ["list_shipments", "galaxy_list_shipments"]) {
      const built = send(name, { created_date_from: "2026-05-06", limit: 5 });
      expect(built.query?.created_date_from).toBe("2026-05-06");
    }
  });

  test("an instant is refused before the call, not by Shiptify's 400", () => {
    expect(() =>
      send("galaxy_list_shipments", {
        created_date_from: "2026-05-06T00:00:00Z",
      }),
    ).toThrow();
  });
});

describe("attachment uploads", () => {
  const file = {
    fileName: "POD_812345",
    documentType: "proof_of_delivery",
    base64Data: "SGVsbG8sIFdvcmxkIQ==",
  };

  test("the file reaches the body instead of an empty object", () => {
    for (const name of [
      "upload_shipment_request_attachment",
      "upload_shipment_attachment",
      "galaxy_upload_shipment_request_attachment",
      "galaxy_upload_shipment_attachment",
    ]) {
      const built = send(name, { id: 812345, attachments: [file] });
      expect(built.body).toEqual({ attachments: [file] });
    }
  });

  test("an invented documentType slug is rejected here, not by Shiptify", () => {
    expect(() =>
      send("upload_shipment_attachment", {
        id: 1,
        attachments: [{ ...file, documentType: "pod_signed" }],
      }),
    ).toThrow();
  });
});

describe("galaxy_update_tracking_point_location", () => {
  test("sends the array of {code, location} the route takes", () => {
    const built = send("galaxy_update_tracking_point_location", {
      id: 9881245,
      code: "STY0358",
      address_id: 329899,
    });

    expect(built.method).toBe("PATCH");
    expect(built.endpoint).toBe(
      "/galaxy/shipments/9881245/tracking-points/location",
    );
    expect(built.body).toEqual([
      { code: "STY0358", location: { address_id: 329899 } },
    ]);
  });
});

describe("shipment response flattening", () => {
  test("projects the counterparty Shiptify actually sends", () => {
    const mapper = shiptifyMappers.response?.shipment;
    if (mapper === undefined) throw new Error("no shipment response mapper");

    const flat = mapper({
      id: 9881245,
      shipper_id: 1343,
      carrier: { id: 1658, name: "Fatton I Nantes", code: "FAT", scac: null },
      shipment_mode: { id: 3, name: "Air" },
    });

    expect(flat).toMatchObject({
      carrier_name: "Fatton I Nantes",
      carrier_id: 1658,
      shipment_mode: "Air",
    });
  });
});
