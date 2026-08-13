import { describe, expect, test } from "bun:test";
import { normalizeEntityName } from "../../src/utils/normalizeEntityName";

/**
 * The record list used to search `label ILIKE '%q%'` OR `normalized_label
 * ILIKE '%q%'` OR the tsvector. The raw-label arm has no index — a leading
 * wildcard rules out a btree and no trigram index covers `label` — and one
 * unindexable branch drags the whole OR down to a sequential scan: measured on
 * 200 000 rows, 261 ms with it against 54 ms without, the plan going from
 * `Seq Scan` to `BitmapOr`.
 *
 * Removing it is only sound if normalising the QUERY matches at least as much
 * as the raw arm did. That is what these assertions pin: `normalized_label`
 * holds `normalizeEntityName(label)`, so a raw-substring hit must survive the
 * transformation on both sides.
 */

/** What the list now does: substring match, both sides normalised. */
const matchesNormalized = (label: string, query: string): boolean => {
  const q = normalizeEntityName(query);
  if (q.length === 0) return false;
  return normalizeEntityName(label).includes(q);
};

/** What it did before: raw substring, case-insensitive. */
const matchedRaw = (label: string, query: string): boolean =>
  label.toLowerCase().includes(query.trim().toLowerCase());

describe("record search — normalising loses none of the raw matches", () => {
  const cases: { label: string; query: string }[] = [
    { label: "Hapag-Lloyd Aktiengesellschaft", query: "hapag" },
    { label: "Hapag-Lloyd Aktiengesellschaft", query: "Lloyd" },
    { label: "Hapag-Lloyd Aktiengesellschaft", query: "HAPAG-LLOYD" },
    { label: "Grafik Studio", query: "grafik stu" },
    { label: "Transalliance", query: "alliance" },
    { label: "Acme Solutions S.A.", query: "acme sol" },
    { label: "Client 4242", query: "4242" },
  ];

  for (const { label, query } of cases) {
    test(`"${query}" still finds "${label}"`, () => {
      expect(matchedRaw(label, query)).toBe(true);
      expect(matchesNormalized(label, query)).toBe(true);
    });
  }
});

describe("record search — normalising finds MORE than the raw arm did", () => {
  test("punctuation in the query no longer breaks the match", () => {
    // The user types the hyphen the label does not have.
    expect(matchedRaw("Hapag Lloyd", "hapag-lloyd")).toBe(false);
    expect(matchesNormalized("Hapag Lloyd", "hapag-lloyd")).toBe(true);
  });

  test("punctuation in the label no longer breaks the match", () => {
    expect(matchedRaw("Hapag-Lloyd", "hapag lloyd")).toBe(false);
    expect(matchesNormalized("Hapag-Lloyd", "hapag lloyd")).toBe(true);
  });

  test("a legal suffix typed by the user stops blocking the match", () => {
    // "Acme SA" vs a label carrying a different suffix form.
    expect(matchedRaw("Acme Solutions S.A.", "acme solutions sa")).toBe(false);
    expect(matchesNormalized("Acme Solutions S.A.", "acme solutions sa")).toBe(
      true,
    );
  });
});

describe("record search — the case normalisation erases", () => {
  test("a query that is ONLY a legal suffix normalises to nothing", () => {
    // The list skips the ILIKE arm entirely here and leaves the query to the
    // tsvector arm, which indexes the RAW label plus the type's text fields —
    // so "SARL" is still findable, through the other branch.
    expect(normalizeEntityName("SARL")).toBe("");
    expect(matchesNormalized("Acme SARL", "SARL")).toBe(false);
  });
});
