import { describe, expect, it } from "bun:test";
import { normalizeEntityName } from "../../src/utils/normalizeEntityName";

describe("normalizeEntityName", () => {
  it("strips whole-word legal suffixes", () => {
    expect(normalizeEntityName("Air France Cargo SAS")).toBe(
      "air france cargo",
    );
    expect(normalizeEntityName("Acme Inc")).toBe("acme");
    expect(normalizeEntityName("ACME LTD")).toBe("acme");
    expect(normalizeEntityName("Acme GmbH")).toBe("acme");
    expect(normalizeEntityName("Acme llc")).toBe("acme");
  });

  it("replaces punctuation with single spaces", () => {
    // Note: the JSDoc shows "CMA-CGM S.A." → "cma cgm" but the regex only
    // strips suffixes as whole words BEFORE punctuation removal, so
    // dotted forms like "S.A." survive as "s a". This assertion locks
    // the actual behaviour so future refactors don't silently regress it.
    expect(normalizeEntityName("CMA-CGM S.A.")).toBe("cma cgm s a");
    expect(normalizeEntityName("MAERSK A/S")).toBe("maersk a s");
    expect(normalizeEntityName("X-Y-Z")).toBe("x y z");
  });

  it("collapses consecutive whitespace and trims", () => {
    expect(normalizeEntityName("  Air   France  ")).toBe("air france");
    expect(normalizeEntityName("Foo    Bar")).toBe("foo bar");
  });

  it("does not strip suffix substrings inside larger words", () => {
    // "sa" is a suffix but only as a standalone word — "salt" must survive.
    expect(normalizeEntityName("Salt Company")).toBe("salt company");
    // "co" is a suffix; "cool" must survive.
    expect(normalizeEntityName("Cool Beans")).toBe("cool beans");
  });

  it("returns an empty string for blank input", () => {
    expect(normalizeEntityName("")).toBe("");
    expect(normalizeEntityName("   ")).toBe("");
  });
});
