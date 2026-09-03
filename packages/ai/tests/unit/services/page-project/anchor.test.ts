import { describe, expect, test } from "bun:test";
import {
  didYouMean,
  findAnchor,
  reindent,
} from "../../../../src/services/page-project/anchor";

/**
 * What an edit is allowed to forgive.
 *
 * The measured failure this exists for: a model reproduces the CODE correctly
 * and the WHITESPACE approximately — a tab where the file has spaces, a
 * trailing space dropped, a block quoted flat. Exact search-replace then finds
 * nothing, and the model's own repair is to widen the anchor, which is how a
 * one-line change comes to cost more than the file it changes.
 *
 * The other half of the contract is what it must NEVER forgive: content. Every
 * strategy here is exact about what the code says.
 */

const FILE = [
  "<template>",
  '  <div class="p-6">',
  '    <UButton color="neutral" @click="reload">',
  "      Refresh",
  "    </UButton>",
  "  </div>",
  "</template>",
].join("\n");

describe("findAnchor — decreasing strictness, first match wins", () => {
  test("exact text is found exactly", () => {
    const found = findAnchor(FILE, '<UButton color="neutral" @click="reload">');
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.strategy).toBe("exact");
    expect(found.matches).toHaveLength(1);
    expect(found.matches[0]?.line).toBe(3);
  });

  test("a trailing space the file does not have still finds its line", () => {
    const found = findAnchor(FILE, "      Refresh   ");
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.strategy).toBe("trailing-whitespace");
    expect(found.matches[0]?.line).toBe(4);
  });

  test("a tab where the file has spaces still finds its line", () => {
    const found = findAnchor(
      FILE,
      '\t<UButton color="neutral"  @click="reload">',
    );
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.strategy).toBe("inner-whitespace");
  });

  test("a block quoted flat finds the indented one", () => {
    const found = findAnchor(
      FILE,
      [
        '<UButton color="neutral" @click="reload">',
        "Refresh",
        "</UButton>",
      ].join("\n"),
    );
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.strategy).toBe("indentation");
    expect(found.matches[0]?.indent).toBe("    ");
  });

  test("different CODE is never forgiven", () => {
    expect(
      findAnchor(FILE, '<UButton color="primary" @click="reload">').found,
    ).toBe(false);
    expect(findAnchor(FILE, "      Refresh now").found).toBe(false);
  });

  test("every occurrence is reported, so ambiguity can be refused", () => {
    const repeated = ["  <p>x</p>", "  <p>x</p>", "  <p>y</p>"].join("\n");
    const found = findAnchor(repeated, "<p>x</p>");
    expect(found.found).toBe(true);
    if (!found.found) return;
    expect(found.matches.map((match) => match.line)).toEqual([1, 2]);
  });
});

describe("reindent — a replacement lands where it is going", () => {
  test("a flat replacement takes the indentation of what it replaces", () => {
    const needle = ["<UButton>", "  Refresh", "</UButton>"].join("\n");
    const found = findAnchor(
      FILE.replace(' color="neutral" @click="reload"', ""),
      needle,
    );
    expect(found.found).toBe(true);
    if (!found.found) return;
    const match = found.matches[0];
    if (match === undefined) throw new Error("no match");
    const out = reindent(
      ["<UButton>", "  Reload", "</UButton>"].join("\n"),
      needle,
      match,
    );
    expect(out.split("\n")).toEqual([
      "    <UButton>",
      "      Reload",
      "    </UButton>",
    ]);
  });

  test("a replacement already at the right indentation is untouched", () => {
    const needle = '    <UButton color="neutral" @click="reload">';
    const found = findAnchor(FILE, needle);
    expect(found.found).toBe(true);
    if (!found.found) return;
    const match = found.matches[0];
    if (match === undefined) throw new Error("no match");
    const replacement = '    <UButton color="primary" @click="reload">';
    expect(reindent(replacement, needle, match)).toBe(replacement);
  });
});

describe("didYouMean — the line it was probably aiming at", () => {
  test("names the line and makes the whitespace visible", () => {
    const hint = didYouMean(FILE, '<UButton color="neutral" @click="refresh">');
    expect(hint).not.toBeNull();
    expect(hint ?? "").toContain("·");
    expect(hint ?? "").toContain("@click=");
  });

  test("says nothing rather than pointing at the wrong line", () => {
    expect(
      didYouMean(FILE, "const unrelated = computeSomethingElse(42);"),
    ).toBe(null);
  });
});
