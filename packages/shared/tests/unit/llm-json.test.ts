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
