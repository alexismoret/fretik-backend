import { describe, expect, it } from "bun:test";
import type { FieldDefinition, FieldDefinitionType } from "../../src/db/schema";
import {
  dropAutoIndex,
  indexesTextPrefix,
  indexName,
  indexTargetsForType,
  TEXT_INDEX_PREFIX,
} from "../../src/services/collection-schema/indexes";
import { classifyAutoIndexes } from "../../src/services/collection-schema/reconcile-indexes";

/**
 * The index policy, pinned without a database.
 *
 * Nothing here is a preference — each assertion stands on a measurement that a
 * future edit would silently undo:
 *
 *  - a btree tuple cannot exceed 2704 bytes, so indexing free text WHOLE turns
 *    a read optimisation into a write outage (a 2700-char insert fails). Text
 *    keys on a prefix; the assertions below are what keep it that way;
 *  - array columns answer `@>` / `&&`, which btree cannot serve at all — GIN or
 *    nothing;
 *  - the name is the idempotence key. `CREATE INDEX … IF NOT EXISTS` only
 *    no-ops on a second call because the same column always hashes to the same
 *    name, and `dropAutoIndex` only refuses foreign indexes because that name
 *    has a grammar it can check.
 */

let seq = 1;
const makeField = (
  partial: Partial<FieldDefinition> & {
    key: string;
    type: FieldDefinitionType;
  },
): FieldDefinition => ({
  id: `00000000-0000-7000-0000-${(seq++).toString().padStart(12, "0")}`,
  organizationId: "11111111-1111-1111-1111-111111111111",
  teamId: "22222222-2222-2222-2222-222222222222",
  collectionId: "33333333-3333-3333-3333-333333333333",
  label: partial.key,
  description: null,
  config: {},
  aiExtractionEnabled: true,
  vectorizeInclude: true,
  displayInPanel: true,
  isTitle: false,
  indexUnusedSince: null,
  indexDroppedAt: null,
  enabled: true,
  displayOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...partial,
});

const TYPE_ID = "44444444-4444-4444-4444-444444444444";

const targetFor = (field: FieldDefinition) => {
  const [target] = indexTargetsForType([field]);
  return target;
};

describe("index method follows the PHYSICAL type", () => {
  it("keys text on a prefix — a whole-value btree breaks INSERT past 2704 bytes", () => {
    for (const type of [
      "text",
      "select",
      "url",
      "email",
      "phone",
    ] as FieldDefinitionType[]) {
      const target = targetFor(makeField({ key: "k", type }));
      expect(target?.sqlType).toBe("text");
      expect(indexesTextPrefix(target?.sqlType ?? "")).toBe(true);
    }
    // 500 four-byte characters stay well under the 2704-byte tuple ceiling.
    expect(TEXT_INDEX_PREFIX * 4).toBeLessThan(2704);
  });

  it("never prefixes a fixed-width type — there is no ceiling to dodge", () => {
    const fixed: [FieldDefinitionType, string][] = [
      ["number", "numeric"],
      ["rating", "numeric"],
      ["date", "timestamptz"],
      ["boolean", "boolean"],
      ["unique_id", "bigint"],
      ["location", "bigint"],
      ["member", "uuid"],
    ];
    for (const [type, sqlType] of fixed) {
      const target = targetFor(makeField({ key: "k", type }));
      expect(target?.sqlType).toBe(sqlType);
      expect(indexesTextPrefix(sqlType)).toBe(false);
    }
  });

  it("leaves array columns to GIN — btree cannot answer && or @>", () => {
    const multi = targetFor(makeField({ key: "tags", type: "multi_select" }));
    expect(multi?.sqlType).toBe("text[]");
    // A prefix key would be meaningless on an array, and a plain btree cannot
    // serve the containment operators the filters actually emit.
    expect(indexesTextPrefix("text[]")).toBe(false);
    expect(indexesTextPrefix("uuid[]")).toBe(false);
  });

  it("indexes money on the amount, not the currency", () => {
    const target = targetFor(makeField({ key: "prix", type: "money" }));
    expect(target?.column).toBe("prix_amount");
    expect(target?.sqlType).toBe("numeric");
    expect(
      indexTargetsForType([makeField({ key: "prix", type: "money" })]),
    ).toHaveLength(1);
  });
});

describe("indexTargetsForType — what is deliberately left unindexed", () => {
  it("skips computed fields, which have no column at all", () => {
    const fields = [
      makeField({ key: "rel", type: "relation" }),
      makeField({ key: "roll", type: "rollup" }),
      makeField({ key: "who", type: "created_by" }),
      makeField({ key: "when", type: "created_time" }),
    ];
    expect(indexTargetsForType(fields)).toEqual([]);
  });

  it("skips markdown — long prose is searched through the vector, never sorted", () => {
    expect(
      indexTargetsForType([makeField({ key: "notes", type: "markdown" })]),
    ).toEqual([]);
  });

  it("skips disabled fields", () => {
    expect(
      indexTargetsForType([
        makeField({ key: "old", type: "text", enabled: false }),
      ]),
    ).toEqual([]);
  });

  it("skips a field whose index the maintenance pass retired", () => {
    // The other half of the loop: without this, reconciliation would rebuild on
    // the next pass exactly what pruning just dropped. `noteIndexWanted` clears
    // the stamp when a query asks for the field again.
    const dropped = makeField({
      key: "cold",
      type: "number",
      indexDroppedAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(indexTargetsForType([dropped])).toEqual([]);
    expect(
      indexTargetsForType([{ ...dropped, indexDroppedAt: null }]),
    ).toHaveLength(1);
  });

  it("carries the field id, so pruning can stamp the row it dropped", () => {
    const field = makeField({ key: "montant", type: "number" });
    expect(targetFor(field)?.fieldId).toBe(field.id);
  });
});

describe("indexName", () => {
  it("is stable — which is what makes IF NOT EXISTS idempotent", () => {
    expect(indexName(TYPE_ID, "montant")).toBe(indexName(TYPE_ID, "montant"));
  });

  it("separates columns, and separates types", () => {
    expect(indexName(TYPE_ID, "montant")).not.toBe(indexName(TYPE_ID, "quand"));
    expect(indexName(TYPE_ID, "montant")).not.toBe(
      indexName("55555555-5555-5555-5555-555555555555", "montant"),
    );
  });

  it("fits Postgres' 63-char identifier limit even on a long column name", () => {
    const long = "a".repeat(60);
    expect(indexName(TYPE_ID, long).length).toBeLessThanOrEqual(63);
  });

  it("always produces a name the drop guard accepts", () => {
    // The two halves have to agree: any name this module composes must be one
    // `dropAutoIndex` will act on, or an index could never be retired.
    for (const column of ["k", "montant_amount", "a".repeat(60)]) {
      expect(indexName(TYPE_ID, column)).toMatch(
        /^ix_[0-9a-f]{32}_[0-9a-f]{8}$/,
      );
    }
  });
});

/** The error a call raised, or null if it went through. */
const dropError = async (name: string): Promise<unknown> =>
  dropAutoIndex(name).then(
    () => null,
    (cause: unknown) => cause,
  );

/**
 * The retirement half of the loop, which has to be symmetric with the building
 * half: anything this module CREATES it must remain able to retire, in every
 * direction a table can move — grown past the threshold, shrunk back under it,
 * or left carrying an index for a field nobody wants any more.
 */
describe("classifyAutoIndexes", () => {
  const wanted = new Map([
    ["ix_aaa_11111111", "field-a"],
    ["ix_aaa_22222222", "field-b"],
  ]);

  it("separates what Postgres reads from what it does not", () => {
    expect(
      classifyAutoIndexes(
        [
          { name: "ix_aaa_11111111", scans: 42 },
          { name: "ix_aaa_22222222", scans: 0 },
        ],
        wanted,
      ),
    ).toEqual({ scanned: ["field-a"], idle: ["field-b"], orphans: [] });
  });

  it("calls an index no current field wants an ORPHAN", () => {
    // Disabling a field leaves its column — and therefore its index — in place
    // while removing it from the target list. Before this branch existed, the
    // pruning pass simply skipped such an index and it lived forever.
    const { orphans, scanned, idle } = classifyAutoIndexes(
      [
        { name: "ix_aaa_11111111", scans: 3 },
        { name: "ix_aaa_99999999", scans: 0 },
      ],
      wanted,
    );
    expect(orphans).toEqual(["ix_aaa_99999999"]);
    expect(scanned).toEqual(["field-a"]);
    expect(idle).toEqual([]);
  });

  it("an orphan is an orphan even when it is being read", () => {
    // Scans do not save it: the question the grace period asks is "is this
    // still read?", and for an orphan the field it served is already gone.
    expect(
      classifyAutoIndexes([{ name: "ix_aaa_99999999", scans: 900 }], wanted)
        .orphans,
    ).toEqual(["ix_aaa_99999999"]);
  });

  it("nothing to classify is not an error", () => {
    expect(classifyAutoIndexes([], wanted)).toEqual({
      scanned: [],
      idle: [],
      orphans: [],
    });
  });
});

describe("dropAutoIndex refuses anything it did not compose", () => {
  const foreign = [
    "collection_records_pkey",
    "ix_not_hex_deadbeef",
    "ix_44444444444444444444444444444444_deadbeef; DROP TABLE users",
    'ix_44444444444444444444444444444444_deadbeef"',
    "ix_44444444444444444444444444444444_dead",
  ];
  for (const name of foreign) {
    it(`refuses ${name}`, async () => {
      // The name is interpolated into raw DDL, so the grammar check is the only
      // thing standing between a caller and an arbitrary DROP.
      expect(await dropError(name)).toBeInstanceOf(Error);
    });
  }
});
