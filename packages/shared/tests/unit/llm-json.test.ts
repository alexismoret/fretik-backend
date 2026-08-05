import { describe, expect, test } from "bun:test";
import { parseLlmJsonObject } from "../../src/lib/llm-json";

/**
 * Contract of the shared defensive LLM-JSON parse — including the repair of
 * the exact glitch observed live (P6, gpt-oss digest run): the closing quote
 * of the last string value dropped before the final `}`.
 */
describe("parseLlmJsonObject", () => {
  test("plain JSON object", () => {
    expect(parseLlmJsonObject('{"title":"A","summary":"B"}')).toEqual({
      title: "A",
      summary: "B",
    });
  });

  test("fenced / prosy completion", () => {
    expect(
      parseLlmJsonObject('Here you go:\n```json\n{"title":"A"}\n```'),
    ).toEqual({ title: "A" });
  });

  test("repairs the dropped closing quote before the final brace", () => {
    expect(
      parseLlmJsonObject('{"title":"A","summary":"Le dossier est clôturé.}'),
    ).toEqual({ title: "A", summary: "Le dossier est clôturé." });
  });

  test("null when nothing parses", () => {
    expect(parseLlmJsonObject("no json here")).toBeNull();
    expect(parseLlmJsonObject('{"title": totally broken]')).toBeNull();
  });

  test("rebalances a stray closer with intact content", () => {
    expect(parseLlmJsonObject('{"title":"T","summary":"S"]}')).toEqual({
      title: "T",
      summary: "S",
    });
  });

  test("rebalances the exact deepseek digest slip observed 2026-08-05", () => {
    // Probe replay of the r19 `unparsable (658 chars)` failure: full JSON,
    // perfect content, one stray `]` before the final `}` — 1/40 at temp 0.
    const raw =
      '{"title":"Volta Energie – Devis signé en 2026-08-03","summary":"Le fournisseur *Volta Energie* a été créé le 3 Août 2026 avec le secteur *énergie renouvelable*. Rapidement, le statut est passé de *prospect qualifié* à *devis signé*, avec un montant de **128 000 €**."]}';
    const parsed = parseLlmJsonObject(raw);
    expect(parsed).toMatchObject({
      title: "Volta Energie – Devis signé en 2026-08-03",
    });
  });

  test("rebalance never completes an unclosed document on the default path", () => {
    // Cut mid-array = truncation: only the opt-in salvage path may accept it.
    expect(parseLlmJsonObject('{"records":[{"a":1},{"a":2y')).toBeNull();
  });

  test("fenced block wins over a stray brace in surrounding prose", () => {
    expect(
      parseLlmJsonObject('Note {draft}\n```json\n{"title":"A"}\n```\nBye }'),
    ).toEqual({ title: "A" });
  });

  test("unclosed fence (truncated completion) still parses", () => {
    expect(parseLlmJsonObject('```json\n{"title":"A"}')).toEqual({
      title: "A",
    });
  });

  test("salvageTruncation recovers complete rows from an array cut mid-record", () => {
    const cut = '{"records":[{"a":1},{"a":2},{"a":3';
    expect(parseLlmJsonObject(cut)).toBeNull();
    expect(parseLlmJsonObject(cut, { salvageTruncation: true })).toEqual({
      records: [{ a: 1 }, { a: 2 }],
    });
  });

  test("salvageTruncation stays off by default and off-path for valid JSON", () => {
    expect(parseLlmJsonObject('{"a":1}', { salvageTruncation: true })).toEqual({
      a: 1,
    });
  });
});
