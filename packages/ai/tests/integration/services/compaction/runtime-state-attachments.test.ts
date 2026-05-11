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
  })) as UIMessage["parts"],
});

describe("extractRuntimeState — activatedTools", () => {
  test("empty history → empty snapshot", () => {
    expect(extractRuntimeState([])).toEqual({
      activatedTools: [],
      pendingTasks: [],
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

describe("extractRuntimeState — pendingTasks", () => {
  test("filters completed, keeps in_progress + pending", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "manageTasks",
          toolCallId: "call-1",
          output: {
            tasks: [
              {
                content: "Step 1",
                activeForm: "Step 1ing",
                status: "completed",
              },
              {
                content: "Step 2",
                activeForm: "Step 2ing",
                status: "in_progress",
              },
              { content: "Step 3", activeForm: "Step 3ing", status: "pending" },
            ],
          },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.pendingTasks).toHaveLength(2);
    expect(state.pendingTasks[0]?.content).toBe("Step 2");
    expect(state.pendingTasks[1]?.content).toBe("Step 3");
  });

  test("latest manageTasks result wins (full-replacement semantics)", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "manageTasks",
          toolCallId: "call-1",
          output: {
            tasks: [
              {
                content: "Old task",
                activeForm: "Doing old",
                status: "in_progress",
              },
            ],
          },
        },
      ]),
      assistantWithToolPart("a2", [
        {
          toolName: "manageTasks",
          toolCallId: "call-2",
          output: {
            tasks: [
              {
                content: "New task",
                activeForm: "Doing new",
                status: "pending",
              },
            ],
          },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.pendingTasks).toHaveLength(1);
    expect(state.pendingTasks[0]?.content).toBe("New task");
  });

  test("malformed task entries are skipped silently", () => {
    const messages = [
      assistantWithToolPart("a1", [
        {
          toolName: "manageTasks",
          toolCallId: "call-1",
          output: {
            tasks: [
              { content: "Valid", activeForm: "Validing", status: "pending" },
              { content: "Missing activeForm", status: "pending" },
              { content: "Bad status", activeForm: "x", status: "weird" },
            ],
          },
        },
      ]),
    ];
    const state = extractRuntimeState(messages);
    expect(state.pendingTasks).toHaveLength(1);
    expect(state.pendingTasks[0]?.content).toBe("Valid");
  });
});

describe("formatRuntimeStateForSummary", () => {
  test("returns empty string for an empty snapshot", () => {
    expect(
      formatRuntimeStateForSummary({ activatedTools: [], pendingTasks: [] }),
    ).toBe("");
  });

  test("formats activatedTools as a single comma-joined line", () => {
    const out = formatRuntimeStateForSummary({
      activatedTools: ["listDocuments", "querySql"],
      pendingTasks: [],
    });
    expect(out).toContain("Active domain tools");
    expect(out).toContain("listDocuments, querySql");
  });

  test("formats pendingTasks as a numbered list with status labels", () => {
    const out = formatRuntimeStateForSummary({
      activatedTools: [],
      pendingTasks: [
        { content: "Step A", activeForm: "Doing A", status: "in_progress" },
        { content: "Step B", activeForm: "Doing B", status: "pending" },
      ],
    });
    expect(out).toContain("1. Step A (in_progress)");
    expect(out).toContain("2. Step B (pending)");
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
