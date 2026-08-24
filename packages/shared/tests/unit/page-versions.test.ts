import { describe, expect, test } from "bun:test";
import {
  PAGE_VERSION_COALESCE_MS,
  shouldCoalescePageVersion,
} from "../../src/services/pages/versions";

/**
 * Which writes collapse into one restore point.
 *
 * The stake is the retention window: one build issues ~10 targeted edits in a
 * few minutes, so without coalescing a single agent turn would evict all
 * twenty stored states — including the one the user actually wants back, which
 * is the state from BEFORE the build started.
 */

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms);

const previous = (
  over: Partial<{
    operation: string;
    byActor: string;
    byConversationId: string | null;
    createdAt: Date;
  }> = {},
) => ({
  operation: "update",
  byActor: "agent",
  byConversationId: "conv-1",
  createdAt: ago(60_000),
  ...over,
});

const next = (
  over: Partial<{
    operation: "create" | "update" | "restore" | "review-round";
  }> = {},
) => ({
  operation: "update" as const,
  actor: { actor: "agent" as const, conversationId: "conv-1" },
  ...over,
});

describe("shouldCoalescePageVersion", () => {
  test("folds consecutive edits from one agent turn into one restore point", () => {
    expect(shouldCoalescePageVersion(previous(), next(), NOW)).toBe(true);
  });

  test("a page with no history starts one", () => {
    expect(shouldCoalescePageVersion(null, next(), NOW)).toBe(false);
  });

  test("a later editing session is its own state", () => {
    expect(
      shouldCoalescePageVersion(
        previous({ createdAt: ago(PAGE_VERSION_COALESCE_MS + 1) }),
        next(),
        NOW,
      ),
    ).toBe(false);
  });

  test("a different conversation is a different session", () => {
    expect(
      shouldCoalescePageVersion(
        previous({ byConversationId: "conv-2" }),
        next(),
        NOW,
      ),
    ).toBe(false);
  });

  test("a person's edit never disappears into the agent's", () => {
    // The whole point of the history is undoing what the agent did; letting an
    // agent write absorb the human state before it would erase the target.
    expect(
      shouldCoalescePageVersion(previous({ byActor: "user" }), next(), NOW),
    ).toBe(false);
  });

  test("review checkpoints never merge — the loop compares them", () => {
    expect(
      shouldCoalescePageVersion(
        previous(),
        next({ operation: "review-round" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldCoalescePageVersion(
        previous({ operation: "review-round" }),
        next(),
        NOW,
      ),
    ).toBe(false);
  });

  test("create and restore stand alone", () => {
    expect(
      shouldCoalescePageVersion(previous(), next({ operation: "create" }), NOW),
    ).toBe(false);
    expect(
      shouldCoalescePageVersion(
        previous(),
        next({ operation: "restore" }),
        NOW,
      ),
    ).toBe(false);
  });
});
