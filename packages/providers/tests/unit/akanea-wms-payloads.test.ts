import { describe, expect, test } from "bun:test";
import { toIntegrationResult } from "../../src/akanea-wms/handlers";
import {
  akaneaDate,
  boolToOn,
  field,
  looseNumber,
  onToBool,
} from "../../src/akanea-wms/normalize";
import {
  itemFields,
  partyFields,
  preparationFields,
  receptionFields,
  toParamFields,
  toWire,
} from "../../src/akanea-wms/payloads";

/**
 * The wire projection and the value converters are the parts of this
 * provider that a live smoke test exercises only indirectly: a silently
 * dropped field or a boolean sent as `true` instead of `"O"` surfaces as a
 * rejected EDI flow hours later, not as a failed call. These tests pin the
 * contract of `payloads.ts` (snake_case in, PascalCase out) and of the
 * Xtent conventions in `normalize.ts`.
 */

describe("toWire projection", () => {
  test("renames declared fields and drops everything else", () => {
    const body = toWire(receptionFields, {
      client_code_id: "246",
      movement_code_id: "ENT",
      supplier_name: "Dupont SA",
      not_a_declared_field: "dropped",
    });

    expect(body).toEqual({
      ClientCodeId: "246",
      MovementCodeId: "ENT",
      SupplierName: "Dupont SA",
    });
  });

  test("omits absent fields instead of sending nulls", () => {
    const body = toWire(receptionFields, {
      client_code_id: "246",
      supplier_name: undefined,
      carrier_name: null,
    });

    expect(body).toEqual({ ClientCodeId: "246" });
  });

  test("projects nested lines and fills internal_item_id from item_code", () => {
    const body = toWire(receptionFields, {
      client_code_id: "246",
      lines: [
        { line_number: 1, item_code: "AAA-01", expected_sale_units: 120 },
        {
          line_number: 2,
          item_code: "BBB-02",
          internal_item_id: "42",
          expected_sale_units: 60,
        },
      ],
    });

    expect(body.EdiReceptionDetailsList).toEqual([
      {
        LineNumber: 1,
        ItemCode: "AAA-01",
        ExpectedSaleUnit: 120,
        InternalItemId: "AAA-01",
      },
      {
        LineNumber: 2,
        ItemCode: "BBB-02",
        ExpectedSaleUnit: 60,
        InternalItemId: "42",
      },
    ]);
  });

  test("converts booleans to Xtent's O / N flags", () => {
    expect(toWire(preparationFields, { urgent: true }).Urgent).toBe("O");
    expect(toWire(partyFields, { available: false }).Available).toBe("N");
  });

  test("keeps the item priority racks Xtent requires", () => {
    const body = toWire(itemFields, {
      client_code_id: "246",
      item_code: "AAA-01",
      description: "Blister",
      priority_racks: [{ warehouse_id: "DEPA", movement_type: "ENT" }],
    });

    expect(body.EdiItemPriorityRack).toEqual([
      { WarehouseId: "DEPA", MovementType: "ENT" },
    ]);
  });

  test("exposes every declared key to the manifest validator", () => {
    // `validateActionArgs` strips undeclared keys, so a field missing from
    // the ParamSpec map can never reach `toWire`.
    const declared = Object.keys(toParamFields(receptionFields));
    for (const entry of receptionFields) {
      expect(declared).toContain(entry.key);
    }
  });
});

describe("Xtent value conventions", () => {
  test("reads O / N booleans in both directions", () => {
    expect(onToBool("O")).toBe(true);
    expect(onToBool("n")).toBe(false);
    expect(onToBool("")).toBeUndefined();
    expect(boolToOn(true)).toBe("O");
    expect(boolToOn("O")).toBeUndefined();
  });

  test("passes Xtent's offset-less timestamps through untouched", () => {
    // Observed on a live install: `2026-08-05T15:30:03`, the warehouse's
    // own wall clock. Parsing it would read it in the Fretik server's
    // timezone and re-emit it in UTC, moving a dock slot by hours.
    expect(akaneaDate("2026-08-05T15:30:03")).toBe("2026-08-05T15:30:03");
    expect(akaneaDate("2026-08-12T09:30:00Z")).toBe("2026-08-12T09:30:00Z");
  });

  test("converts the WCF epoch form, the only shape naming a real instant", () => {
    expect(akaneaDate("/Date(1735689600000+0100)/")).toBe(
      "2025-01-01T00:00:00.000Z",
    );
    expect(akaneaDate("not a date")).toBe("not a date");
    expect(akaneaDate(undefined)).toBeUndefined();
  });

  test("reads quoted numerics and comma decimals", () => {
    expect(looseNumber("12")).toBe(12);
    expect(looseNumber("12,5")).toBe(12.5);
    expect(looseNumber("")).toBeUndefined();
  });

  test("matches response fields whatever the serializer's casing", () => {
    expect(field({ ItemCode: "AAA" }, "ItemCode")).toBe("AAA");
    expect(field({ itemCode: "AAA" }, "ItemCode")).toBe("AAA");
    expect(field({ other: 1 }, "ItemCode")).toBeUndefined();
  });
});

describe("toIntegrationResult", () => {
  test("harvests flow ids, entity ids and references", () => {
    const result = toIntegrationResult({
      result: {
        FlowsId: [{ FlowID: 8412 }],
        ResultOfReceptionsIntegration: [
          { OrderReference: "PO-4421", XtentReceptionId: 91204 },
        ],
      },
    });

    expect(result).toMatchObject({
      flow_ids: [8412],
      entity_ids: [91204],
      references: ["PO-4421"],
      accepted_count: 1,
      errors: [],
    });
  });

  test("reads flow ids serialized as bare numbers", () => {
    // The verify-later contract hangs off this value — a scalar list must
    // not silently produce zero flows.
    expect(
      toIntegrationResult({ result: { FlowsId: [8412, 8413] } }),
    ).toMatchObject({ flow_ids: [8412, 8413] });
  });

  test("excludes rejected rows from accepted_count and surfaces their errors", () => {
    const result = toIntegrationResult({
      result: {
        ResultOfReceptionsIntegration: [
          { OrderReference: "PO-1" },
          { OrderReference: "PO-2", ListOfErrors: ["Unknown item BBB-02"] },
        ],
      },
    });

    expect(result.accepted_count).toBe(1);
    expect(result.errors).toEqual(["Unknown item BBB-02"]);
  });

  test("counts parties, whose result collection the vendor never documented", () => {
    expect(
      toIntegrationResult({
        result: { ResultOfPartysIntegration: [{ Id: "19" }] },
      }),
    ).toMatchObject({ accepted_count: 1 });
  });
});
