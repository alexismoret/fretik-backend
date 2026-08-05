import { describe, expect, test } from "bun:test";
import { langfuseMask } from "../../../src/lib/langfuse-mask";

/**
 * The mask runs on the STRINGIFIED JSON of every observation, so an
 * over-greedy pattern does not just over-redact — it can corrupt a bare JSON
 * number into a non-JSON token and make the whole payload unparseable.
 *
 * That is what the card pattern did: `\b` fires after the dot of a float, so
 * `"passFraction":0.6666666666666666` came back `0.***CARD***` and the recall
 * eval's stored outcome could no longer be read back (measured 2026-08).
 */

const mask = (input: string): string => {
  const out = langfuseMask({ data: input });
  return typeof out === "string" ? out : "";
};

describe("langfuseMask — card pattern", () => {
  test("redacts card numbers, spaced or bare", () => {
    expect(mask("card 4111 1111 1111 1111 here")).toContain("***CARD***");
    expect(mask('{"pan":"4111111111111111"}')).toContain("***CARD***");
    expect(mask("4111-1111-1111-1111")).toContain("***CARD***");
  });

  test("leaves a float mantissa intact and JSON-parseable", () => {
    const payload = JSON.stringify({ passFraction: 2 / 3 });
    const masked = mask(payload);
    expect(masked).not.toContain("***CARD***");
    expect(() => JSON.parse(masked)).not.toThrow();
  });

  test("does not fire inside a longer digit run", () => {
    expect(mask("id 12345678901234567890")).not.toContain("***CARD***");
  });
});

describe("langfuseMask — other redactions still fire", () => {
  test("email and bearer token", () => {
    expect(mask("write to a.b@example.com")).toContain("***EMAIL***");
    expect(mask("Authorization: Bearer abc.def-ghi")).toContain("Bearer ***");
  });
});
