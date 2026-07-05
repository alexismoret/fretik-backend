import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../../src/lib/redact-secrets";

/**
 * The defense-in-depth net under the distill prompts' sensitivity guard
 * (P8.2): credential-shaped strings are scrubbed even when the model
 * cosmetically reformats them, ordinary business text is left untouched.
 */
describe("redactSecrets", () => {
  test("scrubs an ASCII sk- key, keeps surrounding text", () => {
    expect(
      redactSecrets("La clé live est sk-live-9f8a7b6c5d4e3f2a1b0c, garde-la."),
    ).toBe("La clé live est [redacted], garde-la.");
  });

  test("scrubs a key rewritten with U+2011 non-breaking hyphens (the observed leak)", () => {
    // "sk‑live‑9f8a7b6c5d4e3f2a1b0c" — the exact bypass a utility
    // model produced; the ASCII regex alone would miss it.
    const key = "sk‑live‑9f8a7b6c5d4e3f2a1b0c";
    const out = redactSecrets(`Clé: ${key} (enregistrée)`);
    expect(out).toBe("Clé: [redacted] (enregistrée)");
    expect(out).not.toContain("9f8a7b6c5d4e3f2a1b0c");
  });

  test("scrubs Stripe, GitHub, Slack, AWS, Google, JWT and Bearer tokens", () => {
    const cases: [string, string][] = [
      // Stripe publishable test key (public by design — not a push-protected
      // secret) exercising the same `[sprk]k_(live|test)_…` redaction branch.
      ["pk_test_TYooMQauvdEDq54NiTphI7jx", "[redacted]"],
      ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "[redacted]"],
      ["xoxb-1234567890-abcdefghijkl", "[redacted]"],
      ["AKIAIOSFODNN7EXAMPLE", "[redacted]"],
      [`AIza${"b".repeat(35)}`, "[redacted]"],
      [
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4",
        "[redacted]",
      ],
      [
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
        "Authorization: Bearer [redacted]",
      ],
    ];
    for (const [input, expected] of cases) {
      expect(redactSecrets(input)).toBe(expected);
    }
  });

  test("leaves ordinary business text (incl. real hyphens) untouched", () => {
    const clean =
      "Commande CMD-2027 pour Meridian Textiles : remise 8 %, paiement à 30 jours, livraison le 30 juin 2026.";
    expect(redactSecrets(clean)).toBe(clean);
  });
});
