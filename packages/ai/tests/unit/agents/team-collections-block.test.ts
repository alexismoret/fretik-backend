import type { TeamSchemaCollection } from "@fretik/shared/services/collections/describe-team-schema";
import { describe, expect, it } from "bun:test";
import { formatTeamCollectionsBlock } from "../../../src/agents/chatbot/team-collections-block";

/**
 * `<team_collections>` is where the agent reads a type's columns to build SQL. It
 * must render the EXACT queryable column names — the agent was guessing bare
 * `label`/`status`, a non-existent `name`, or the bare key of a `money` field
 * (whose real columns are `<key>_amount`/`<key>_currency`).
 */

/**
 * `fields` is OMITTED from the `Partial` before the intersection: intersecting
 * it instead means a literal has to satisfy both shapes, so `isTitle` was
 * required after all and every fixture here failed to typecheck. The point of
 * the override is that a fixture may leave `isTitle` out.
 */
const makeType = (
  over: Omit<Partial<TeamSchemaCollection>, "fields"> & {
    key: string;
    fields: {
      key: string;
      type: TeamSchemaCollection["fields"][number]["type"];
      isTitle?: boolean;
      synced?: boolean;
    }[];
  },
): TeamSchemaCollection => ({
  id: "00000000-0000-7000-0000-000000000001",
  key: over.key,
  label: over.label ?? over.key,
  labelPlural: over.labelPlural ?? null,
  description: over.description ?? null,
  isSystem: false,
  icon: null,
  color: null,
  viewName: over.viewName ?? "data.coll_deadbeef",
  fields: over.fields.map((f) => ({ ...f, isTitle: f.isTitle ?? false })),
  relations: over.relations ?? [],
  // Absent unless a case sets one — `exactOptionalPropertyTypes` makes an
  // explicit `undefined` a different thing from an absent key.
  ...(over.syncedFrom === undefined ? {} : { syncedFrom: over.syncedFrom }),
});

describe("formatTeamCollectionsBlock", () => {
  it("leads every column list with the system columns id, _label, _status, created_at, updated_at", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "clients",
        fields: [{ key: "commercial", type: "text" }],
      }),
    ]);
    expect(block).toContain(
      "columns: id, _label, _status, created_at, updated_at, commercial (text)",
    );
    // It must NOT advertise a bare `label`/`status`/`name`.
    expect(block).not.toMatch(/columns: [^;]*\blabel\b(?!_)/);
  });

  it("tags the title field so the agent knows _label's source (no invented `name`)", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "clients",
        fields: [
          { key: "company_name", type: "text", isTitle: true },
          { key: "commercial", type: "text" },
        ],
      }),
    ]);
    // The title field is marked; non-title fields are not.
    expect(block).toContain("company_name (text, title)");
    expect(block).toContain("commercial (text)");
    expect(block).not.toContain("commercial (text, title)");
  });

  it("renders a money field as its two real columns", () => {
    const block = formatTeamCollectionsBlock([
      makeType({ key: "deals", fields: [{ key: "value", type: "money" }] }),
    ]);
    expect(block).toContain("value_amount, value_currency (money)");
    // The bare key would be a non-existent column.
    expect(block).not.toMatch(/\bvalue \(money\)/);
  });

  /**
   * A synced column is queryable like any other, and its figures have an age.
   *
   * The age needs the CADENCE beside it or it says nothing: four hours old is
   * normal on a daily source and a fault on a quarter-hourly one, and nothing
   * else in the agent's context distinguishes them.
   */
  it("tags a synced column and names the app, the action, the age and the cadence", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "orders",
        fields: [
          { key: "reference", type: "text", isTitle: true },
          { key: "revenue", type: "number", synced: true },
        ],
        syncedFrom: {
          app: "Acme",
          operation: "list_orders",
          lastSuccessAt: new Date("2026-09-16T09:12:34.000Z"),
          schedule: { mode: "interval", everyMinutes: 15 },
          incremental: false,
          otherSources: 0,
        },
      }),
    ]);
    expect(block).toContain("revenue (number, synced)");
    // Not the title field, which is local.
    expect(block).toContain("reference (text, title)");
    expect(block).toContain(
      "synced: Acme list_orders, 2026-09-16 09:12, every 15 min",
    );
  });

  it("warns that an incremental source's deletions lag, and counts the others", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "orders",
        fields: [{ key: "revenue", type: "number", synced: true }],
        syncedFrom: {
          app: "Acme",
          operation: "list_orders",
          lastSuccessAt: new Date("2026-09-16T09:12:34.000Z"),
          schedule: { mode: "manual" },
          incremental: true,
          otherSources: 2,
        },
      }),
    ]);
    // A manual source has no cadence to state, and saying "every undefined
    // min" would be worse than saying nothing.
    expect(block).toContain("2026-09-16 09:12, manual");
    // The collection is complete only up to the last full walk.
    expect(block).toContain("full walk daily");
    // Other sources fill other columns — findable, not listed here.
    expect(block).toContain("+2 more source(s)");
  });

  /**
   * The rule about what `synced` OBLIGES lives in `<collections>`, which is
   * above the cache marker. This block is re-rendered every turn, so a rule
   * restated here is the same sentence bought again on every message.
   */
  it("states no rule — the tag points, `<collections>` rules", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "orders",
        fields: [{ key: "revenue", type: "number", synced: true }],
        syncedFrom: {
          app: "Acme",
          operation: "list_orders",
          lastSuccessAt: new Date("2026-09-16T09:12:34.000Z"),
          schedule: { mode: "interval", everyMinutes: 60 },
          incremental: false,
          otherSources: 0,
        },
      }),
    ]);
    expect(block).not.toContain("never UPDATE");
    expect(block).not.toContain("refreshSync");
  });

  it("says nothing about sync when nothing is synced", () => {
    const block = formatTeamCollectionsBlock([
      makeType({ key: "clients", fields: [{ key: "name", type: "text" }] }),
    ]);
    expect(block).not.toContain("synced");
  });

  it("excludes relation/rollup fields from the column list (not real columns)", () => {
    const block = formatTeamCollectionsBlock([
      makeType({
        key: "products",
        fields: [
          { key: "price", type: "number" },
          { key: "supplier", type: "relation" },
          { key: "total_spend", type: "rollup" },
        ],
      }),
    ]);
    expect(block).toContain("price (number)");
    expect(block).not.toContain("supplier (relation)");
    expect(block).not.toContain("total_spend (rollup)");
  });
});
