import { describe, expect, test } from "bun:test";
import { AKANEA_READ_ENTITIES } from "../../src/akanea-wms/read-fields";

/**
 * The read-field table is what the generated SKILL.md teaches a caller to
 * filter on, so it is only worth anything while it still describes the
 * mappers. This holds it against `handlers.ts` itself: rename a property
 * there and this turns red, instead of the skill quietly teaching a name that
 * Xtent answers with a fault in an HTTP 200.
 */

/** Which mapper reads which entity. The nested stock-object mappers
 * (`toStockLine`, `toSsccLine`) are deliberately absent: they map rows of a
 * child collection, not filterable columns of the entity — which is exactly
 * what the entity's `caveat` warns about. */
const MAPPER_ENTITY: Record<string, string> = {
  toItemQuantity: "EnItemQuantities",
  toStockMovement: "EnStockMovements",
  toReception: "EnReception",
  toPreparation: "EnPreparation",
  toItem: "EnItem",
};

const FIELD_CALL =
  /^\s*(\w+):\s*(strField|numField|boolField|dateField|relStrField)\(row,\s*"([^"]+)"(?:,\s*"([^"]+)")?\)/gm;

/** (python → xtent) as `handlers.ts` actually reads them. */
const mappersFromSource = async (): Promise<
  Map<string, Map<string, string>>
> => {
  const source = await Bun.file(
    new URL("../../src/akanea-wms/handlers.ts", import.meta.url),
  ).text();

  const byEntity = new Map<string, Map<string, string>>();
  const mapperBlock =
    /const (to\w+) = \(row: unknown\)[^=]*=>\s*\n?\s*compactRow\(\{(.*?)\n {2}\}\);/gs;

  for (const [, mapper = "", body = ""] of source.matchAll(mapperBlock)) {
    const entity = MAPPER_ENTITY[mapper];
    if (!entity) continue;
    const fields = new Map<string, string>();
    for (const [, python = "", , head = "", tail] of body.matchAll(
      FIELD_CALL,
    )) {
      fields.set(python, tail ? `${head}.${tail}` : head);
    }
    byEntity.set(entity, fields);
  }
  return byEntity;
};

describe("Akanea read-field table vs handlers.ts", () => {
  test("every mapper the table claims to describe was found in the source", async () => {
    const parsed = await mappersFromSource();

    // Guards the parser itself: a refactor that changes the mapper shape must
    // not silently turn this suite into five vacuous assertions.
    expect([...parsed.keys()].sort()).toEqual(
      Object.values(MAPPER_ENTITY).sort(),
    );
    for (const fields of parsed.values()) {
      expect(fields.size).toBeGreaterThan(10);
    }
  });

  test.each(Object.values(MAPPER_ENTITY))(
    "%s maps exactly the fields the table publishes",
    async (entity) => {
      const parsed = (await mappersFromSource()).get(entity);
      const declared = AKANEA_READ_ENTITIES.find((e) => e.entity === entity);
      expect(declared).toBeDefined();

      const declaredPairs = Object.fromEntries(
        (declared?.fields ?? []).map((f) => [f.python, f.xtent]),
      );
      expect(Object.fromEntries(parsed ?? [])).toEqual(declaredPairs);
    },
  );

  test("the traps that produced real faults are recorded, not smoothed over", () => {
    const field = (entity: string, python: string) =>
      AKANEA_READ_ENTITIES.find((e) => e.entity === entity)?.fields.find(
        (f) => f.python === python,
      );

    // "No property or field 'OrderReference' exists in type 'EnPreparation'"
    expect(field("EnPreparation", "order_reference")?.xtent).toBe("Order");
    // "No property or field 'SuAvailable' exists in type 'EnItemQuantities'"
    expect(field("EnItemQuantities", "su_available")?.xtent).toBe(
      "SUAvaillable",
    );
    // "No property or field 'ClientName' exists in type 'EnItem'"
    expect(field("EnItem", "client_name")?.xtent).toBe("Client.Name");
    // "Operator '=' incompatible with operand types 'Int64' and 'String'"
    expect(field("EnPreparation", "client_code_id")?.type).toBe("Int64");
  });

  test("every entity whose read returns lines warns that filters hit the header", () => {
    for (const entity of AKANEA_READ_ENTITIES) {
      const returnsLines = entity.actions.some(
        (a) =>
          a.endsWith("_stored") ||
          a.endsWith("_prepared") ||
          a.endsWith("_sscc"),
      );
      if (returnsLines) expect(entity.caveat).toBeTruthy();
    }
  });
});
