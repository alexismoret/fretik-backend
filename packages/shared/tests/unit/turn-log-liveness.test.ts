import { describe, expect, test } from "bun:test";
import { parseTurnLogChunks } from "../../src/services/ai/turn-drain";
import {
  isTurnLogOrphan,
  pendingToolsAfter,
  TURN_LOG_IDLE_ORPHAN_MS,
  TURN_LOG_TOOL_ORPHAN_MS,
} from "../../src/services/ai/turn-log";

/**
 * Liveness is a POLICY, so it is pinned. The failure it replaces, measured
 * 2026-08-21: an in-process page render starved every timer in the
 * service, the 5s producer ping fired minutes apart, and a single 20s
 * silence deadline declared live turns dead the moment a tool ran longer
 * than that — viewers closed, the slot cleared, the finished work never
 * shown. The verdict now derives from the log's CONTENT: what the tail
 * says the turn is doing decides how much silence it is owed.
 */

describe("pendingToolsAfter", () => {
  test("a completed input opens; an output or error closes", () => {
    let n = 0;
    n = pendingToolsAfter({ type: "tool-input-available" }, n);
    expect(n).toBe(1);
    n = pendingToolsAfter({ type: "tool-input-available" }, n);
    expect(n).toBe(2);
    n = pendingToolsAfter({ type: "tool-output-available" }, n);
    expect(n).toBe(1);
    n = pendingToolsAfter({ type: "tool-output-error" }, n);
    expect(n).toBe(0);
  });

  test("streaming the arguments is NOT an opening — the wire is alive", () => {
    // `tool-input-start`/`-delta` mean the model is still emitting; only
    // `tool-input-available` marks the hand-off into a silent execute.
    expect(pendingToolsAfter({ type: "tool-input-start" }, 0)).toBe(0);
    expect(pendingToolsAfter({ type: "tool-input-delta" }, 0)).toBe(0);
  });

  test("floors at zero, and ignores non-chunk values", () => {
    expect(pendingToolsAfter({ type: "tool-output-available" }, 0)).toBe(0);
    expect(pendingToolsAfter(null, 3)).toBe(3);
    expect(pendingToolsAfter("data-ping", 3)).toBe(3);
    expect(pendingToolsAfter({ type: "text-delta" }, 3)).toBe(3);
  });
});

describe("isTurnLogOrphan", () => {
  const now = 1_000_000_000;

  test("an ended log is never an orphan", () => {
    expect(
      isTurnLogOrphan({ ended: true, lastEntryMs: 0, pendingTools: 0 }, now),
    ).toBe(false);
  });

  test("idle silence is judged by the idle deadline", () => {
    const at = (age: number) => ({
      ended: false,
      lastEntryMs: now - age,
      pendingTools: 0,
    });
    expect(isTurnLogOrphan(at(TURN_LOG_IDLE_ORPHAN_MS - 1), now)).toBe(false);
    expect(isTurnLogOrphan(at(TURN_LOG_IDLE_ORPHAN_MS + 1), now)).toBe(true);
  });

  test("a tool in flight buys the long deadline — silence is expected", () => {
    // The exact measured kill: 49s of silence during a python sleep, and
    // ~3 minutes during a buildPage, both while the turn was alive and
    // productive. Neither may read as death while a tool is executing.
    const midTool = (age: number) => ({
      ended: false,
      lastEntryMs: now - age,
      pendingTools: 1,
    });
    expect(isTurnLogOrphan(midTool(TURN_LOG_IDLE_ORPHAN_MS + 1), now)).toBe(
      false,
    );
    expect(isTurnLogOrphan(midTool(TURN_LOG_TOOL_ORPHAN_MS - 1), now)).toBe(
      false,
    );
    expect(isTurnLogOrphan(midTool(TURN_LOG_TOOL_ORPHAN_MS + 1), now)).toBe(
      true,
    );
  });

  test("the deadlines keep their ordering and floor", () => {
    // The tool deadline must exceed the slowest legitimate tool budget
    // (the giga build evals at 240s), and the idle one must cover slow
    // first-token latency — a 20s value is the measured regression.
    expect(TURN_LOG_TOOL_ORPHAN_MS).toBeGreaterThan(240_000);
    expect(TURN_LOG_IDLE_ORPHAN_MS).toBeGreaterThanOrEqual(60_000);
    expect(TURN_LOG_TOOL_ORPHAN_MS).toBeGreaterThan(TURN_LOG_IDLE_ORPHAN_MS);
  });
});

describe("parseTurnLogChunks", () => {
  const entry = (
    id: string,
    fields: string[],
  ): [id: string, fields: string[]] => [id, fields];

  test("replays data chunks in order, skipping pings and markers", () => {
    const chunks = parseTurnLogChunks([
      entry("1-0", ["m", "open"]),
      entry("2-0", ["d", '{"type":"start","messageId":"m1"}', "p", "0"]),
      entry("3-0", ["d", '{"type":"data-ping","data":{"t":1}}', "p", "0"]),
      entry("4-0", ["d", '{"type":"text-delta","id":"t","delta":"hi"}']),
      entry("5-0", ["m", "end", "r", "error"]),
    ]);
    expect(chunks.map((c) => c.type)).toEqual(["start", "text-delta"]);
  });

  test("one corrupt entry does not void the salvage of the rest", () => {
    const chunks = parseTurnLogChunks([
      entry("1-0", ["d", "{not json"]),
      entry("2-0", ["d", '{"type":"text-start","id":"t"}']),
    ]);
    expect(chunks.map((c) => c.type)).toEqual(["text-start"]);
  });
});
