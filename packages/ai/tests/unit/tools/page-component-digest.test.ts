import { describe, expect, test } from "bun:test";
import { readComponentDocs } from "../../../src/tools/page-component-docs";

/**
 * What a component lookup costs, and what it must never stop containing.
 *
 * The full reference for six heavy components measures ~32k tokens — more than
 * the whole skill corpus, spent in one call, on a library the model already
 * knows. The digest keeps the half it cannot guess (props, slots, emits) and
 * drops the half it can (usage prose, worked examples).
 *
 * Pinned against the REAL corpus, like its sibling contract test: the property
 * has to survive `sync-nuxt-ui-docs` refreshing the library.
 */

const referenceOf = async (name: string, full?: boolean): Promise<string> => {
  const result = await readComponentDocs(
    [name],
    full === undefined ? undefined : { full },
  );
  if ("error" in result) throw new Error(result.error);
  const doc = result.docs[0];
  if (!doc) throw new Error(`no reference for ${name}`);
  return doc.reference;
};

describe("component API digest", () => {
  test("keeps the contract of the component that shipped a broken page", async () => {
    // Two defects came out of UTable: content placed in a guessed slot, and a
    // row handler written as `(row) => …` when the real signature passes the
    // EVENT first. Both live in the API half; losing either to a size
    // optimisation would reintroduce what this lookup exists to prevent.
    const digest = await referenceOf("UTable");
    expect(digest).toContain("### Props");
    expect(digest).toContain("### Slots");
    expect(digest).toContain("onSelect?: (e: Event, row: TableRow<T>)");
  });

  test("keeps the emits of a component that declares them", async () => {
    expect(await referenceOf("UModal")).toContain("### Emits");
  });

  test("drops the prose the model does not need", async () => {
    const digest = await referenceOf("UTable");
    expect(digest).not.toContain("\n## Usage");
    expect(digest).not.toContain("\n## Examples");
  });

  test("says how to get the rest, so the cut is a choice and not a wall", async () => {
    expect(await referenceOf("UTable")).toContain("full: true");
  });

  test("full: true still returns everything", async () => {
    const full = await referenceOf("UTable", true);
    expect(full).toContain("## Usage");
    expect(full.length).toBeGreaterThan((await referenceOf("UTable")).length);
  });

  test("a heavy component's lookup shrinks by a large factor", async () => {
    const [digest, full] = await Promise.all([
      referenceOf("UNavigationMenu"),
      referenceOf("UNavigationMenu", true),
    ]);
    expect(digest.length).toBeLessThan(full.length / 2);
  });
});

describe("composition", () => {
  test("the overlay that broke three pages shows where its panel goes", async () => {
    // `USlideover` declares nine peer slots and nothing in that interface says
    // `default` is the TRIGGER. A compose form placed there renders
    // permanently inline and the panel opens empty — it compiles, it logs
    // nothing, and it shipped. The snippet is what makes the nesting visible.
    const digest = await referenceOf("USlideover");
    expect(digest).toContain("## Composition");
    expect(digest).toContain("Parts placed by name");
    expect(digest).toMatch(/#(content|body)/);
    expect(digest).toContain("```vue");
  });

  test("a table's per-column slots survive, though the interface omits them", async () => {
    // `#<column>-cell` is how a table renders anything but a raw value. It is
    // absent from `### Slots`, and the examples that use it sit inside a
    // 335-line block the line budget cuts — so the digest used to describe a
    // table the page could not format, and pages printed `[object Object]`.
    const digest = await referenceOf("UTable");
    expect(digest).toContain("## Composition");
    expect(digest).toMatch(/-cell/);
  });

  test("composition is above the cut, so the default lookup carries it", async () => {
    const digest = await referenceOf("UModal");
    expect(digest.indexOf("## Composition")).toBeGreaterThan(
      digest.indexOf("## API"),
    );
    expect(digest).not.toContain("\n## Usage");
  });

  test("a component with no named parts gets no composition block", async () => {
    // UBadge is label, leading, trailing — nothing anybody mis-places. A block
    // there would be noise, and noise is what teaches an agent to skim.
    expect(await referenceOf("UBadge")).not.toContain("## Composition");
  });
});
