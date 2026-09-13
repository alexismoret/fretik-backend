import { describe, expect, test } from "bun:test";
import { decideFreshness } from "../../../../src/services/chat-suggestions/freshness";

/**
 * When an LLM call is spent. Pure, and worth pinning exactly: every branch
 * here is either a bill or a person waiting.
 */

const NOW = new Date("2026-09-13T12:00:00.000Z");
const HASH = "abc";
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

describe("decideFreshness", () => {
  test("no batch — the one case where somebody waits", () => {
    expect(decideFreshness(null, HASH, NOW)).toBe("generate");
  });

  test("unchanged workspace — costs nothing", () => {
    expect(
      decideFreshness(
        { createdAt: ago(30 * MINUTE), inputHash: HASH },
        HASH,
        NOW,
      ),
    ).toBe("serve");
  });

  test("changed workspace, but minutes old — still costs nothing", () => {
    // One upload must not re-price the screen.
    expect(
      decideFreshness(
        { createdAt: ago(30 * MINUTE), inputHash: "old" },
        HASH,
        NOW,
      ),
    ).toBe("serve");
  });

  test("changed workspace, over an hour old — rewrite underneath", () => {
    expect(
      decideFreshness(
        { createdAt: ago(2 * HOUR), inputHash: "old" },
        HASH,
        NOW,
      ),
    ).toBe("serve-and-refresh");
  });

  test("a day old — rewrite even if nothing changed", () => {
    // The pack's hash carries the date, so this is belt and braces: a
    // suggestion about "this week" ages whether or not the workspace moved.
    expect(
      decideFreshness(
        { createdAt: ago(25 * HOUR), inputHash: HASH },
        HASH,
        NOW,
      ),
    ).toBe("serve-and-refresh");
  });

  test("never makes the reader wait when something is already on screen", () => {
    const stale = decideFreshness(
      { createdAt: ago(48 * HOUR), inputHash: "old" },
      HASH,
      NOW,
    );
    expect(stale).not.toBe("generate");
  });
});
