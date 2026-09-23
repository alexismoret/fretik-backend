import { probabilityOf, thresholdFor } from "@fretik/shared/decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "@fretik/shared/schemas/decisions";
import type { JournalEntry } from "@fretik/shared/services/decisions/journal";
import { answerJournalEntry } from "@fretik/shared/services/decisions/journal-entry";

/**
 * The nightly consolidation's first question: does this cluster need the
 * judge at all?
 *
 * The judge is a full LLM call with reasoning, run once per cluster of
 * episodes that anchor overlapping records. Most clusters are distinct
 * matters that merely share a client or a project, and the judge's answer
 * for those is NOOP. Two yes/no questions to the decision model find those
 * for a fraction of the cost: only a confident "no" to both skips.
 *
 * What it must never skip is a REVISE the question cannot see. The judge
 * revises "a planned date that is now past", which is date arithmetic, the
 * decision model's weak spot. So the CALLER keeps risky clusters away from
 * this entirely (`isRiskyCluster`): any recent activity on the records, or an
 * episode old enough for its plans to have lapsed, goes straight to the judge.
 */

export const PRESCREEN_POINT = "memory.consolidate.prescreen";

/** An episode untouched this long may carry a plan whose date has passed. */
const STALE_EPISODE_MS = 14 * 24 * 60 * 60 * 1000;

export const isRiskyCluster = (params: {
  episodes: readonly { updatedAt: Date }[];
  recentEventCount: number;
  now: Date;
}): boolean =>
  params.recentEventCount > 0 ||
  params.episodes.some(
    (e) => params.now.getTime() - e.updatedAt.getTime() > STALE_EPISODE_MS,
  );

export const PRESCREEN_QUESTIONS: Record<
  "same" | "conflict",
  DecisionQuestion
> = {
  same: {
    type: "boolean",
    instructions:
      "The state lists episodic memories (E1, E2, …) of a workplace team that mention overlapping records. Do at least two of them describe the same matter, one story told twice?",
    criteria: {
      true: "At least two episodes describe the same matter.",
      false: "Each episode describes a different matter.",
    },
  },
  conflict: {
    type: "boolean",
    instructions:
      "The state lists episodic memories (E1, E2, …) of a workplace team, and possibly recent activity on the records they mention. Does any episode state something that another episode or the recent activity contradicts or replaces?",
    criteria: {
      true: "Something in one episode is contradicted or replaced.",
      false: "Nothing in any episode is contradicted or replaced.",
    },
  },
};

export interface PrescreenVerdict {
  /** Both questions came back clearly no. */
  skip: boolean;
  /** The point runs in shadow: the verdict is recorded, the judge still runs. */
  shadow: boolean;
}

/**
 * Skip only on a confident double "no" read against the echoed bars. A
 * missing answer on either question is not a "no", so it never skips.
 */
export const readPrescreen = (
  response: DecisionResponse | null,
): PrescreenVerdict => {
  if (response?.status !== "answered") return { skip: false, shadow: false };
  const shadow = response.policy.mode === "shadow";
  const clearlyNo = (id: "same" | "conflict"): boolean => {
    const p = probabilityOf(response.answers[id]);
    const bar = thresholdFor(response.policy, id);
    return p !== null && bar !== undefined && p < bar;
  };
  return { skip: clearlyNo("same") && clearlyNo("conflict"), shadow };
};

/**
 * One row per question. The judge's action is the reference label while in
 * shadow: MERGE means "same" was true, REVISE means "conflict" was, NOOP
 * means neither. An unreadable judge output labels nothing.
 */
export const prescreenJournalEntries = (params: {
  organizationId: string;
  teamId: string;
  subjectId: string;
  response: DecisionResponse | null;
  verdict: PrescreenVerdict;
  judgeAction: "MERGE" | "REVISE" | "NOOP" | null;
}): JournalEntry[] =>
  (["same", "conflict"] as const).map((questionId) =>
    answerJournalEntry({
      organizationId: params.organizationId,
      teamId: params.teamId,
      point: PRESCREEN_POINT,
      questionId,
      subjectType: "episode",
      subjectId: params.subjectId,
      response: params.response,
      questionCount: 2,
      outcome: params.verdict.skip ? "skip" : "judge",
      applied: params.verdict.skip && !params.verdict.shadow,
      ...(params.judgeAction !== null
        ? {
            legacyLabel:
              params.judgeAction ===
              (questionId === "same" ? "MERGE" : "REVISE")
                ? "true"
                : "false",
          }
        : {}),
    }),
  );
