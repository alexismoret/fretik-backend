import type { TeamSchemaCollection } from "@fretik/shared/services/collections/describe-team-schema";
import { describe, expect, it } from "bun:test";
import { formatTeamCollectionsBlock } from "../../../src/agents/chatbot/team-collections-block";

/**
 * `<team_collections>` is where the agent reads a type's columns to build SQL. It
 * must render the EXACT queryable column names — the agent was guessing bare
 * `label`/`status`, a non-existent `name`, or the bare key of a `money` field
 * (whose real columns are `<key>_amount`/`<key>_currency`).
 */

const makeType = (
  over: Partial<TeamSchemaCollection> & {
    key: string;
    fields: {
      key: string;
      type: TeamSchemaCollection["fields"][number]["type"];
      isTitle?: boolean;
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
