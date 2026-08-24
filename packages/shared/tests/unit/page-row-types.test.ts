import { describe, expect, test } from "bun:test";
// `schemas/pages` reaches `schemas/ontology` → `common/params`, which calls
// `.openapi()` — the method only exists once `@hono/zod-openapi` has patched
// Zod. In a service that happens at boot; here it has to be imported for the
// side effect.
import "@hono/zod-openapi";
import type { PageFieldDescriptor } from "../../src/schemas/pages";
import { describePageDataContract } from "../../src/schemas/pages";
import { renderRowType } from "../../src/services/pages/describe-row-types";

/**
 * The row types handed to the page builder before it probes.
 *
 * Every shape asserted here was READ OFF A LIVE ROW (2026-08-20), not derived
 * from the write schema — the two disagree on exactly the fields that break
 * pages, and a type block that repeated the write schema would be a confident
 * lie in the builder's first message.
 */

const field = (
  key: string,
  type: string,
  extra: Partial<PageFieldDescriptor> = {},
): PageFieldDescriptor => ({ key, label: key, type, ...extra });

const render = (fields: PageFieldDescriptor[]): string =>
  renderRowType({
    key: "eval_page_item",
    label: "Eval Item",
    objectTypeId: "01a00f76-e915-7346-9eb6-f7c25f641db6",
    recordCount: 24,
    fields,
  });

describe("row type rendering", () => {
  test("leads with the objectTypeId, which is derivable from nothing else", () => {
    // A dataset cannot be written without this uuid, and the table name drops
    // its dashes — reconstructing it from `data.obj_<hex>` matches nothing.
    expect(render([field("title", "text")])).toContain(
      "objectTypeId: 01a00f76-e915-7346-9eb6-f7c25f641db6",
    );
  });

  test("carries the record count, which decides how the type is read at all", () => {
    // Enumerate 24 rows, aggregate 5 000 — the page's whole shape turns on it.
    expect(render([field("title", "text")])).toContain("24 records");
  });

  test("names the row's own id and label", () => {
    expect(render([field("title", "text")])).toContain(
      "id: string; label: string",
    );
  });

  test("a select is the union of its option VALUES", () => {
    const rendered = render([
      field("status", "select", {
        options: [
          { value: "todo", label: "To do" },
          { value: "done", label: "Done" },
        ],
      }),
    ]);
    // The value, never the label: `label` is what the badge shows, `value` is
    // what the row holds and what a filter has to match.
    expect(rendered).toContain("status: 'todo' | 'done'");
  });

  test("a relation is a list of {id,label}, not a uuid", () => {
    // Measured: relations reach a page through the links graph as
    // `[{id,label}]`, and `[]` when nothing is linked. A builder that expected
    // the uuid a WRITE takes would render an empty owner column.
    const rendered = render([field("owner", "relation", { writable: false })]);
    expect(rendered).toContain("owner: { id: string; label: string }[]");
    expect(rendered).toContain("read-only");
  });

  test("a rollup is flagged as the string it really is", () => {
    // Measured: a rollup that COUNTS reads back as "0"/"1". Comparing or
    // summing it as a number is the quiet defect this line exists to stop.
    expect(render([field("nb_documents", "rollup")])).toContain("Number() it");
  });

  test("money keeps its two parts", () => {
    expect(
      render([field("budget", "money", { currencyCode: "EUR" })]),
    ).toContain("budget: { amount: number; currencyCode: string }");
  });

  test("a date says which of its two shapes it is", () => {
    expect(render([field("due_at", "date")])).toContain("YYYY-MM-DD");
    expect(render([field("seen_at", "date", { hasTime: true })])).toContain(
      "ISO",
    );
  });

  test("unique_id is a number and its prefix is display-only", () => {
    const rendered = render([field("uid", "unique_id", { prefix: "INV-" })]);
    expect(rendered).toContain("uid: number");
    expect(rendered).toContain("display prefix INV-");
  });
});

describe("the generic row-shape table in the data contract", () => {
  test("states the three shapes that are not guessable", () => {
    const contract = describePageDataContract();
    expect(contract).toContain("## row shapes (objects datasets)");
    expect(contract).toContain("[{ id, label }]");
    expect(contract).toContain("Number() it");
    expect(contract).toContain("{ amount, currencyCode }");
  });
});
