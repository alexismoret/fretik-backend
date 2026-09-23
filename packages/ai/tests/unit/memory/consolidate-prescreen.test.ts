import type {
  DecisionAnswered,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import { DecisionQuestionSchema } from "@fretik/shared/schemas/decisions";
import { describe, expect, test } from "bun:test";
import {
  isRiskyCluster,
  PRESCREEN_QUESTIONS,
  prescreenJournalEntries,
  readPrescreen,
} from "../../../src/services/memory/consolidate-prescreen";

/**
 * The consolidation prescreen: when a cluster may skip the nightly judge.
 *
 * A wrong skip leaves a duplicate or a stale fact standing, so every rule
 * pinned here narrows skipping: only a confident double "no", never on a
 * missing answer, never in shadow, never for a cluster whose staleness is a
 * date the decision model cannot be trusted to compare.
 */

const now = new Date("2026-09-24T03:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);

const answered = (
  same: number | null,
  conflict: number | null,
  over: Partial<DecisionAnswered> = {},
): DecisionResponse => ({
  status: "answered",
  point: "memory.consolidate.prescreen",
  policy: {
    mode: "on",
    questionVersion: 1,
    thresholds: { same: 0.1, conflict: 0.1 },
    minChosenProbability: {},
  },
  answers: {
    ...(same !== null ? { same: { type: "boolean", probability: same } } : {}),
    ...(conflict !== null
      ? { conflict: { type: "boolean", probability: conflict } }
      : {}),
  },
  missing: [],
  transport: "openrouter",
  latencyMs: 80,
  costUsd: 0.00002,
  ...over,
});

describe("isRiskyCluster", () => {
  test("recent activity on the records sends the cluster to the judge", () => {
    expect(
      isRiskyCluster({
        episodes: [{ updatedAt: daysAgo(1) }],
        recentEventCount: 1,
        now,
      }),
    ).toBe(true);
  });

  test("an episode old enough for its plans to have lapsed does too", () => {
    expect(
      isRiskyCluster({
        episodes: [{ updatedAt: daysAgo(1) }, { updatedAt: daysAgo(15) }],
        recentEventCount: 0,
        now,
      }),
    ).toBe(true);
  });

  test("a fresh, quiet cluster may be prescreened", () => {
    expect(
      isRiskyCluster({
        episodes: [{ updatedAt: daysAgo(1) }, { updatedAt: daysAgo(3) }],
        recentEventCount: 0,
        now,
      }),
    ).toBe(false);
  });
});

describe("readPrescreen", () => {
  test("only a confident no to BOTH questions skips", () => {
    expect(readPrescreen(answered(0.05, 0.02)).skip).toBe(true);
    expect(readPrescreen(answered(0.05, 0.3)).skip).toBe(false);
    expect(readPrescreen(answered(0.4, 0.02)).skip).toBe(false);
  });

  test("the bar is exclusive: sitting on it is not a no", () => {
    expect(readPrescreen(answered(0.1, 0.02)).skip).toBe(false);
  });

  test("a missing answer is never a no", () => {
    expect(readPrescreen(answered(0.02, null)).skip).toBe(false);
    expect(readPrescreen(null).skip).toBe(false);
    expect(
      readPrescreen({
        status: "skipped",
        point: "memory.consolidate.prescreen",
        reason: "egress",
      }).skip,
    ).toBe(false);
  });

  test("in shadow the verdict is read, and flagged as not to be acted on", () => {
    const verdict = readPrescreen(
      answered(0.02, 0.02, {
        policy: {
          mode: "shadow",
          questionVersion: 1,
          thresholds: { same: 0.1, conflict: 0.1 },
          minChosenProbability: {},
        },
      }),
    );
    expect(verdict).toEqual({ skip: true, shadow: true });
  });
});

describe("prescreenJournalEntries", () => {
  const rows = (
    judgeAction: "MERGE" | "REVISE" | "NOOP" | null,
    verdict = { skip: false, shadow: true },
  ) =>
    prescreenJournalEntries({
      organizationId: "org",
      teamId: "team",
      subjectId: "0199",
      response: answered(0.05, 0.6),
      verdict,
      judgeAction,
    });

  test("the judge's action becomes each question's reference label", () => {
    expect(rows("MERGE").map((r) => r.legacyLabel)).toEqual(["true", "false"]);
    expect(rows("REVISE").map((r) => r.legacyLabel)).toEqual(["false", "true"]);
    expect(rows("NOOP").map((r) => r.legacyLabel)).toEqual(["false", "false"]);
  });

  test("an unreadable judge output labels nothing", () => {
    for (const row of rows(null)) expect(row.legacyLabel).toBeUndefined();
  });

  test("a shadow skip is journaled as not applied, a live one as applied", () => {
    expect(rows(null, { skip: true, shadow: true })[0]?.applied).toBe(false);
    expect(rows(null, { skip: true, shadow: false })[0]?.applied).toBe(true);
  });

  test("the call's cost is split across the two questions", () => {
    const total = rows("NOOP").reduce((s, r) => s + (r.costUsd ?? 0), 0);
    expect(total).toBeCloseTo(0.00002, 12);
  });
});

describe("PRESCREEN_QUESTIONS", () => {
  test("both questions are valid on the wire", () => {
    for (const question of Object.values(PRESCREEN_QUESTIONS)) {
      expect(DecisionQuestionSchema.safeParse(question).success).toBe(true);
    }
  });
});
