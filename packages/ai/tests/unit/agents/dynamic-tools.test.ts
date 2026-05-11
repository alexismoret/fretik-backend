import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  DynamicToolManager,
  replayActivationFromHistory,
} from "../../../src/agents/shared/dynamic-tools";

describe("DynamicToolManager", () => {
  test("empty snapshot by default", () => {
    const m = new DynamicToolManager();
    expect(m.getSnapshot()).toEqual([]);
    expect(m.isActivated("listDocuments")).toBe(false);
  });

  test("activate() adds names in insertion order", () => {
    const m = new DynamicToolManager();
    m.activate(["listDocuments", "listExtractions"]);
    expect(m.getSnapshot()).toEqual(["listDocuments", "listExtractions"]);
    expect(m.isActivated("listDocuments")).toBe(true);
    expect(m.isActivated("listExtractions")).toBe(true);
  });

  test("activate() is idempotent on duplicates", () => {
    const m = new DynamicToolManager();
    m.activate(["listDocuments"]);
    m.activate(["listDocuments"]);
    m.activate(["listDocuments", "listDocuments"]);
    expect(m.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("activate() preserves first-insertion order across multiple calls", () => {
    const m = new DynamicToolManager();
    m.activate(["a", "b"]);
    m.activate(["b", "c"]);
    m.activate(["a", "d"]);
    expect(m.getSnapshot()).toEqual(["a", "b", "c", "d"]);
  });

  test("getSnapshot() returns an independent array (mutation does not leak)", () => {
    const m = new DynamicToolManager();
    m.activate(["x"]);
    const snap = m.getSnapshot();
    snap.push("rogue");
    expect(m.getSnapshot()).toEqual(["x"]);
  });

  test("activate() with empty list is a no-op", () => {
    const m = new DynamicToolManager();
    m.activate([]);
    expect(m.getSnapshot()).toEqual([]);
  });
});

/**
 * Helper: build a ModelMessage[] containing one or more past
 * `searchTools` tool results. Mirrors the shape the AI SDK
 * serializes our plain-object returns into when rebuilding a
 * conversation history for the next request.
 */
const buildHistoryWithSearchResults = (
  results: ReadonlyArray<{
    matches: string[];
    query?: string;
    toolName?: string;
  }>,
): ModelMessage[] => {
  return results.map((r, i) => ({
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `call-${i}`,
        toolName: r.toolName ?? "searchTools",
        output: {
          type: "json",
          value: {
            matches: r.matches,
            query: r.query ?? "select:" + r.matches.join(","),
            total_deferred_tools: 6,
          },
        },
      },
    ],
  }));
};

describe("replayActivationFromHistory", () => {
  test("empty history is a no-op", () => {
    const m = new DynamicToolManager();
    replayActivationFromHistory(m, [], "searchTools");
    expect(m.getSnapshot()).toEqual([]);
  });

  test("replays matches from a single past searchTools result", () => {
    const m = new DynamicToolManager();
    const history = buildHistoryWithSearchResults([
      { matches: ["listDocuments"] },
    ]);
    replayActivationFromHistory(m, history, "searchTools");
    expect(m.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("replays matches from multiple past searchTools results", () => {
    const m = new DynamicToolManager();
    const history = buildHistoryWithSearchResults([
      { matches: ["listDocuments"] },
      { matches: ["listExtractions", "getExtractionData"] },
    ]);
    replayActivationFromHistory(m, history, "searchTools");
    expect(new Set(m.getSnapshot())).toEqual(
      new Set(["listDocuments", "listExtractions", "getExtractionData"]),
    );
  });

  test("ignores tool results from non-gateway tools", () => {
    const m = new DynamicToolManager();
    const history = buildHistoryWithSearchResults([
      { matches: ["listDocuments"], toolName: "listDocuments" },
      { matches: ["listExtractions"], toolName: "searchTools" },
    ]);
    replayActivationFromHistory(m, history, "searchTools");
    // Only the `searchTools` result should be replayed.
    expect(m.getSnapshot()).toEqual(["listExtractions"]);
  });

  test("ignores non-tool messages (system / user / assistant)", () => {
    const m = new DynamicToolManager();
    const history: ModelMessage[] = [
      { role: "system", content: "you are an assistant" },
      { role: "user", content: "list my documents" },
      { role: "assistant", content: "calling searchTools" },
      ...buildHistoryWithSearchResults([{ matches: ["listDocuments"] }]),
    ];
    replayActivationFromHistory(m, history, "searchTools");
    expect(m.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("skips malformed tool results without throwing", () => {
    const m = new DynamicToolManager();
    const history: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-0",
            toolName: "searchTools",
            // Text output variant — no structured payload to replay.
            output: { type: "text", value: "some plain text" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "searchTools",
            // Missing `matches` field entirely.
            output: { type: "json", value: { query: "whatever" } },
          },
        ],
      },
      // One valid entry after the malformed ones — should still be replayed.
      ...buildHistoryWithSearchResults([{ matches: ["listDocuments"] }]),
    ];
    replayActivationFromHistory(m, history, "searchTools");
    expect(m.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("is idempotent — replaying the same history twice has no additional effect", () => {
    const m = new DynamicToolManager();
    const history = buildHistoryWithSearchResults([
      { matches: ["listDocuments", "listExtractions"] },
    ]);
    replayActivationFromHistory(m, history, "searchTools");
    replayActivationFromHistory(m, history, "searchTools");
    expect(new Set(m.getSnapshot())).toEqual(
      new Set(["listDocuments", "listExtractions"]),
    );
  });
});
