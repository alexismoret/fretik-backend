import { describe, expect, test } from "bun:test";
import {
  SCAN_CARRY_LENGTH,
  scanForbiddenCodepoints,
} from "../../src/lib/text-integrity";

/**
 * The scanner is what lets the breaker act on its own, so its FALSE POSITIVES
 * are the expensive side: a wrong hit, corroborated twice, pulls a working
 * upstream out of a model's pool for a week. Half the cases below are therefore
 * text that must NOT be flagged.
 *
 * Every invisible character is written as an escape on purpose — pasted
 * literally they are unreviewable, which is the whole point of the defect.
 */

const ZWSP = "\u{200B}";
const RTL_OVERRIDE = "\u{202E}";
const BOM = "\u{FEFF}";
const FULLWIDTH_RPAREN = "\u{FF09}";

describe("scanForbiddenCodepoints", () => {
  test("flags a zero-width space and keys it by codepoint", () => {
    const result = scanForbiddenCodepoints(`Total ${ZWSP}314.88`);
    expect(result.total).toBe(1);
    expect(result.hits["U+200B"]).toBe(1);
  });

  test("flags bidi controls and the BOM", () => {
    const result = scanForbiddenCodepoints(`a${RTL_OVERRIDE}b${BOM}c`);
    expect(result.total).toBe(2);
    expect(result.hits["U+202E"]).toBe(1);
    expect(result.hits["U+FEFF"]).toBe(1);
  });

  test("counts every occurrence in the 2026-08-28 CoreWeave fixture", () => {
    // The measured shape: the injection lands on the NUMBERS. A probe written
    // without figures in it never saw this defect at all.
    const result = scanForbiddenCodepoints(
      `Net 1.200, T.Net ${ZWSP}4.800, Total ${ZWSP}314.88`,
    );
    expect(result.total).toBe(2);
    expect(result.hits["U+200B"]).toBe(2);
  });

  test("flags a fullwidth form next to a Western number", () => {
    const before = scanForbiddenCodepoints(`Total ${FULLWIDTH_RPAREN}314.88`);
    expect(before.hits["U+FF09"]).toBe(1);
    const after = scanForbiddenCodepoints(`Total 314${FULLWIDTH_RPAREN} EUR`);
    expect(after.hits["U+FF09"]).toBe(1);
  });

  test("leaves fullwidth punctuation in ordinary CJK prose alone", () => {
    // No digit, no adjacency, no hit. This sentence is what the discriminator
    // exists to protect: flagging it would quarantine a host for writing
    // correct Japanese.
    expect(
      scanForbiddenCodepoints("重要な書類（原本）を送りました。").total,
    ).toBe(0);
  });

  test("flags a CJK number in fullwidth parentheses — the accepted false positive", () => {
    // Named rather than engineered away. The breaker needs two corroborating
    // GENERATIONS in 30 minutes, so one Japanese answer cannot quarantine
    // anything; narrowing the rule to spare it would cost the detector the
    // defect it was built for. Change this only with evidence.
    expect(scanForbiddenCodepoints("商品（3個）を注文").total).toBeGreaterThan(
      0,
    );
  });

  test("sees a defect split across two deltas through the carry", () => {
    // The fullwidth form ends one delta and its digit opens the next: the pair
    // only exists once they are joined.
    const first = scanForbiddenCodepoints(`Total ${FULLWIDTH_RPAREN}`);
    expect(first.total).toBe(0);
    expect(first.carry).toBe(FULLWIDTH_RPAREN);
    expect(first.carry.length).toBe(SCAN_CARRY_LENGTH);

    const second = scanForbiddenCodepoints("314.88", first.carry);
    expect(second.total).toBe(1);
    expect(second.hits["U+FF09"]).toBe(1);

    // Without the carry the same delta is clean — which is the whole reason
    // the caller has to thread it.
    expect(scanForbiddenCodepoints("314.88").total).toBe(0);
  });

  test("counts a boundary hit once: the carry drops what it already counted", () => {
    const first = scanForbiddenCodepoints(`Net 1.200${ZWSP}`);
    expect(first.total).toBe(1);
    expect(first.carry).toBe("");
    expect(scanForbiddenCodepoints("4.800", first.carry).total).toBe(0);
  });

  test("keeps the carry across an empty delta", () => {
    expect(scanForbiddenCodepoints("", FULLWIDTH_RPAREN).carry).toBe(
      FULLWIDTH_RPAREN,
    );
  });

  test("leaves clean French prose alone — accents, em-dashes and figures", () => {
    const clean =
      "Créé le 12 août — reçu n° 4.800 à régler, ça fait 314,88 € (TTC).";
    const result = scanForbiddenCodepoints(clean);
    expect(result.total).toBe(0);
    expect(Object.keys(result.hits)).toHaveLength(0);
  });

  test("reports codepoints and counts, never the text it scanned", () => {
    // These streams are customer documents and conversations. The evidence has
    // to be enough to name the defect and useless for anything else.
    const result = scanForbiddenCodepoints(
      `Facture ACME 1.200${ZWSP} EUR, contact jean@acme.fr`,
    );
    const evidence = JSON.stringify({ hits: result.hits, total: result.total });
    expect(evidence).not.toContain("ACME");
    expect(evidence).not.toContain("Facture");
    expect(evidence).not.toContain("acme.fr");
    for (const key of Object.keys(result.hits)) {
      expect(key).toMatch(/^U\+[0-9A-F]{4,6}$/);
    }
  });
});
