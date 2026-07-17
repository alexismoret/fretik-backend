import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  buildSyntheticActivationReplayMessage,
  extractRuntimeState,
  formatRuntimeStateForSummary,
} from "../../../../src/services/compaction/runtime-state-attachments";

interface BuildToolPart {
  toolName: string;
  toolCallId: string;
  output: unknown;
}

const assistantWithToolPart = (
  id: string,
  parts: BuildToolPart[],
): UIMessage => ({
  id,
  role: "assistant",
  parts: parts.map((p) => ({
    type: `tool-${p.toolName}`,
    toolCallId: p.toolCallId,
    state: "output-available",
    input: { dummy: true },
    output: p.output,
  })),
});

describe("extractRuntimeState — activatedTools", () => {
  test("empty history → empty snapshot", () => {
    expect(extractRuntimeState([])).toEqual({
      activatedTools: [],
    });
  });

  test("collects matches from a single past searchTools result", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "searchTools",
          toolCallId: "call-1",
          output: { matches: ["listDocuments"] },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.activatedTools).toEqual(["listDocuments"]);
  });

  test("accumulates matches across multiple searchTools calls (deduped, first-seen order)", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "searchTools",
          toolCallId: "call-1",
          output: { matches: ["listDocuments"] },
        },
      ]),
      assistantWithToolPart("a2", [
        {
          toolName: "searchTools",
          toolCallId: "call-2",
          output: { matches: ["listExtractions", "listDocuments"] },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.activatedTools).toEqual(["listDocuments", "listExtractions"]);
  });

  test("ignores malformed searchTools payloads (non-array matches)", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "searchTools",
          toolCallId: "call-1",
          output: { matches: "not an array" },
        },
      ]),
      assistantWithToolPart("a2", [
        {
          toolName: "searchTools",
          toolCallId: "call-2",
          output: { matches: ["listDocuments"] },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.activatedTools).toEqual(["listDocuments"]);
  });
});

describe("formatRuntimeStateForSummary", () => {
  test("returns empty string for an empty snapshot", () => {
    expect(formatRuntimeStateForSummary({ activatedTools: [] })).toBe("");
  });

  test("formats activatedTools as a single comma-joined line", () => {
    const out = formatRuntimeStateForSummary({
      activatedTools: ["listDocuments", "querySql"],
    });
    expect(out).toContain("Active domain tools");
    expect(out).toContain("listDocuments, querySql");
  });
});

describe("buildSyntheticActivationReplayMessage", () => {
  test("returns null when no tools were activated", () => {
    expect(buildSyntheticActivationReplayMessage([])).toBeNull();
  });

  test("produces an assistant message with a tool-searchTools part", () => {
    const msg = buildSyntheticActivationReplayMessage([
      "listDocuments",
      "querySql",
    ]);
    expect(msg).not.toBeNull();
    if (!msg) return;
    expect(msg.role).toBe("assistant");
    expect(msg.parts).toHaveLength(1);
    const part = msg.parts[0] as {
      type: string;
      state: string;
      output: { matches: string[]; query: string };
    };
    expect(part.type).toBe("tool-searchTools");
    expect(part.state).toBe("output-available");
    expect(part.output.matches).toEqual(["listDocuments", "querySql"]);
    expect(part.output.query).toBe("select:listDocuments,querySql");
  });
});
