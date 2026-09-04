import { describe, expect, test } from "bun:test";
import {
  catalogueComponentNames,
  renderComponentCatalogue,
} from "../../../src/tools/page-component-catalogue";
import { listComponentNames } from "../../../src/tools/page-component-docs";

/**
 * The catalogue is the answer to a measurement, and these tests are what keep
 * it answering.
 *
 * Across ten generated pages, seventeen components out of the hundred and
 * seventeen the runtime registers carried every screen — a table, a slideover,
 * a select, a skeleton, an empty state and icons. The cause was not the
 * catalogue being closed; it was that no catalogue existed in the prompt, so
 * the model composed out of whatever the prose had named most often, and the
 * prose named two components "the default".
 *
 * Pinned against the REAL file, like the digest tests: a component added by a
 * `@nuxt/ui` upgrade must fail here rather than quietly become invisible.
 */

/** One `## job` block, whole. Sections carry blank lines, so they cannot be
 * split apart on them — the boundary is the next heading. */
const jobSection = (job: string): string => {
  const catalogue = renderComponentCatalogue();
  const start = catalogue.indexOf(`## ${job} —`);
  if (start === -1) return "";
  const rest = catalogue.slice(start);
  const end = rest.indexOf("\n## ", 1);
  return end === -1 ? rest : rest.slice(0, end);
};

describe("component catalogue", () => {
  test("covers every component the runtime registers, exactly once", async () => {
    const registered = (await listComponentNames()).sort();
    const catalogued = catalogueComponentNames()
      .map((name) => `U${name}`)
      .sort();

    expect(catalogued).toEqual(registered);
    expect(new Set(catalogued).size).toBe(catalogued.length);
  });

  test("ranks no component above its peers", () => {
    // The regression this whole file exists for. `UTable` was "the default for
    // records" and `USlideover` "the default for click a row"; both then
    // appeared in the list of components whose over-use marks a generated
    // page. A catalogue that ranks is a catalogue that decides for the builder.
    //
    // "the default slot" is a different word doing a different job — it names
    // a slot, and banning it would cost the one fact that breaks pages.
    const catalogue = renderComponentCatalogue().toLowerCase();
    expect(catalogue).not.toMatch(/the default(?! slot)/);
    for (const phrase of ["the usual choice", "always reach for"]) {
      expect(catalogue).not.toContain(phrase);
    }
  });

  test("every excluded component says why the frame cannot run it", () => {
    const lines = jobSection("excluded")
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(lines.length).toBeGreaterThan(5);
    // A reason, not a verdict: "not for pages" teaches nothing and invites the
    // model to weigh it against its own taste, which is exactly what an
    // exclusion must not be open to.
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(40);
    }
  });

  test("the shell components stay out and the page-level rails stay in", () => {
    const catalogue = renderComponentCatalogue();
    const excluded = jobSection("excluded");

    for (const name of ["UApp", "UDashboardPanel", "UHeader"]) {
      expect(excluded).toContain(`\`${name}\``);
    }
    // The doctrine asks for "a rail down one side" and these are how a page
    // builds one. Excluding them alongside the app's own shell is what left
    // that instruction with no implementation.
    for (const name of ["USidebar", "UPageAside", "UPage"]) {
      expect(catalogue).toContain(`\`${name}\``);
      expect(excluded).not.toContain(`\`${name}\``);
    }
  });

  test("fits the prompt budget it was given", () => {
    // 117 components is what this section must ENUMERATE, so the budget
    // follows the list rather than the appetite: ~180 characters each buys
    // what it is, when it earns the screen, when it does not, and the prop
    // that unlocks it. Past this, a line is turning into a paragraph.
    expect(renderComponentCatalogue().length).toBeLessThan(22_000);
  });

  test("renders every job group, in the order a screen is decided", () => {
    const headings = [
      ...renderComponentCatalogue().matchAll(/^## (\w+) —/gm),
    ].map((match) => match[1]);
    expect(headings).toEqual([
      "structure",
      "navigation",
      "records",
      "value",
      "input",
      "overlay",
      "feedback",
      "content",
      "excluded",
    ]);
  });
});
