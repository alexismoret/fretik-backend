import type { UIMessage } from "ai";
import { describe, expect, test } from "bun:test";
import {
  COMPACTABLE_TOOLS,
  KEEP_RECENT_COMPACTABLE_RESULTS,
  microcompactMessages,
} from "../../../../src/services/compaction/microcompact";

const userMsg = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

interface BuildToolPart {
  toolName: string;
  toolCallId: string;
  output: unknown;
  state?: "output-available" | "input-available";
}

const assistantWithToolPart = (
  id: string,
  parts: BuildToolPart[],
): UIMessage => {
  // Cast through `unknown` once at the boundary — we're constructing
  // a runtime-shaped fixture that the AI SDK's `UIMessage` type
  // models as a discriminated union we can't satisfy structurally
  // without one of the per-tool generic-typed factories. Localised
  // to test fixtures only; production code stays cast-free per
  // CLAUDE.md.
  const built = parts.map((p) => ({
    type: `tool-${p.toolName}`,
    toolCallId: p.toolCallId,
    state: p.state ?? "output-available",
    input: { dummy: true },
    output: p.output,
  }));
  return {
    id,
    role: "assistant",
    parts: built as unknown as UIMessage["parts"],
  };
};

/**
 * Read the `output` field off a `UIMessage`'s first part without using
 * `as` casts in the call site. Returns `undefined` when the shape
 * doesn't match what we expect from the fixture builder above. Tests
 * assert against this return value.
 */
const readFirstPartOutput = (msg: UIMessage | undefined): unknown => {
  if (!msg) return undefined;
  const part = msg.parts[0];
  if (
    part === undefined ||
    part === null ||
    typeof part !== "object" ||
    !("output" in part)
  ) {
    return undefined;
  }
  return part.output;
};

describe("COMPACTABLE_TOOLS — derived from registry metadata", () => {
  test("includes the load-bearing read-only tools", () => {
    expect(COMPACTABLE_TOOLS.has("searchKnowledge")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("querySql")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("read")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("listDocuments")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("webFetch")).toBe(true);
    expect(COMPACTABLE_TOOLS.has("vision")).toBe(true);
  });

  test("excludes searchTools (replay-critical)", () => {
    expect(COMPACTABLE_TOOLS.has("searchTools")).toBe(false);
  });

  test("excludes mutating / state-bearing tools", () => {
    expect(COMPACTABLE_TOOLS.has("manageTasks")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("memory")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("python")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("bash")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("presentFiles")).toBe(false);
    expect(COMPACTABLE_TOOLS.has("downloadDriveDocument")).toBe(false);
  });
});

describe("microcompactMessages — clearing behavior", () => {
  test("returns input by reference when nothing matches", () => {
    const msgs = [userMsg("u1", "hello"), userMsg("u2", "world")];
    expect(microcompactMessages(msgs)).toBe(msgs);
  });

  test("returns input by reference when ≤ keepRecent compactable results", () => {
    const msgs: UIMessage[] = [];
    for (let i = 0; i < KEEP_RECENT_COMPACTABLE_RESULTS; i++) {
      msgs.push(
        assistantWithToolPart(`a${i.toString()}`, [
          {
            toolName: "searchKnowledge",
            toolCallId: `call-${i.toString()}`,
            output: { chunks: ["a", "b"] },
          },
        ]),
      );
    }
    expect(microcompactMessages(msgs)).toBe(msgs);
  });

  test("clears the older results when total exceeds keepRecent", () => {
    const total = KEEP_RECENT_COMPACTABLE_RESULTS + 3;
    const msgs: UIMessage[] = [];
    for (let i = 0; i < total; i++) {
      msgs.push(
        assistantWithToolPart(`a${i.toString()}`, [
          {
            toolName: "searchKnowledge",
            toolCallId: `call-${i.toString()}`,
            output: { chunks: [`chunk-${i.toString()}-data`] },
          },
        ]),
      );
    }
    const out = microcompactMessages(msgs);
    expect(out).not.toBe(msgs);
    // First 3 should be cleared, last keepRecent kept verbatim.
    for (let i = 0; i < 3; i++) {
      const output = readFirstPartOutput(out[i]);
      expect(typeof output).toBe("string");
      expect(String(output)).toContain("Old searchKnowledge tool result");
      expect(String(output)).toContain(`call-${i.toString()}`);
    }
    for (let i = 3; i < total; i++) {
      const output = readFirstPartOutput(out[i]);
      expect(typeof output).toBe("object");
    }
  });

  test("does NOT clear non-compactable tools (manageTasks, searchTools)", () => {
    const total = KEEP_RECENT_COMPACTABLE_RESULTS + 3;
    const msgs: UIMessage[] = [];
    // First 3: non-compactable tools — must remain verbatim.
    msgs.push(
      assistantWithToolPart("a-st", [
        {
          toolName: "searchTools",
          toolCallId: "call-st",
          output: { matches: ["listDocuments"] },
        },
      ]),
    );
    msgs.push(
      assistantWithToolPart("a-mt", [
        {
          toolName: "manageTasks",
          toolCallId: "call-mt",
          output: {
            tasks: [{ content: "x", activeForm: "Xing", status: "pending" }],
          },
        },
      ]),
    );
    msgs.push(
      assistantWithToolPart("a-py", [
        {
          toolName: "python",
          toolCallId: "call-py",
          output: { stdout: "result" },
        },
      ]),
    );
    // Then `total` compactable results — older ones get cleared.
    for (let i = 0; i < total; i++) {
      msgs.push(
        assistantWithToolPart(`a${i.toString()}`, [
          {
            toolName: "searchKnowledge",
            toolCallId: `call-${i.toString()}`,
            output: { chunks: [`chunk-${i.toString()}`] },
          },
        ]),
      );
    }
    const out = microcompactMessages(msgs);
    // searchTools / manageTasks / python must stay structured (not cleared).
    expect(typeof readFirstPartOutput(out[0])).toBe("object");
    expect(typeof readFirstPartOutput(out[1])).toBe("object");
    expect(typeof readFirstPartOutput(out[2])).toBe("object");
  });

  test("does not mutate the input array", () => {
    const total = KEEP_RECENT_COMPACTABLE_RESULTS + 2;
    const msgs: UIMessage[] = [];
    for (let i = 0; i < total; i++) {
      msgs.push(
        assistantWithToolPart(`a${i.toString()}`, [
          {
            toolName: "querySql",
            toolCallId: `call-${i.toString()}`,
            output: { rows: [{ id: i }] },
          },
        ]),
      );
    }
    const original = msgs.map((m) => m.parts[0]);
    microcompactMessages(msgs);
    msgs.forEach((m, i) => {
      expect(m.parts[0]).toBe(original[i]);
    });
  });

  test("ignores non output-available tool parts (e.g. input-available state)", () => {
    const total = KEEP_RECENT_COMPACTABLE_RESULTS + 1;
    const msgs: UIMessage[] = [];
    msgs.push(
      assistantWithToolPart("a-pending", [
        {
          toolName: "searchKnowledge",
          toolCallId: "call-pending",
          output: undefined,
          state: "input-available",
        },
      ]),
    );
    for (let i = 0; i < total; i++) {
      msgs.push(
        assistantWithToolPart(`a${i.toString()}`, [
          {
            toolName: "searchKnowledge",
            toolCallId: `call-${i.toString()}`,
            output: { chunks: [`c-${i.toString()}`] },
          },
        ]),
      );
    }
    const out = microcompactMessages(msgs);
    // The `input-available` part is not counted as a hit, so the
    // total of compactable hits = `total` (= keepRecent + 1).
    // Therefore exactly 1 older output is cleared.
    let clearedSeen = 0;
    for (const m of out) {
      const output = readFirstPartOutput(m);
      if (
        typeof output === "string" &&
        output.includes("Old searchKnowledge")
      ) {
        clearedSeen++;
      }
    }
    expect(clearedSeen).toBe(1);
  });
});
