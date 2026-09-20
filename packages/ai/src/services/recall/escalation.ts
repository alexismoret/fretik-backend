import { evaluateDecisions } from "../decisions/evaluate";
import type { VerbatimSelection } from "./verbatim";
import { shouldEscalateToJudge } from "./verbatim";

/**
 * Who decides whether a turn goes to the recall judge.
 *
 * `score` is what ships today and stays the default: `bestScore` under
 * `JUDGE_ESCALATION_BEST_SCORE`. Its own comment is candid about the limit —
 * over 230 eval repeats the cases that must abstain and the cases that must
 * cite OVERLAP on score, so no threshold decides the question; a threshold
 * can only sort. What it cannot do is read the message.
 *
 * `decision` is exactly that missing reader, at a price a hot path can pay:
 * a typed question answered in well under a second against the message and
 * the candidate labels, rather than a number that admits it is guessing.
 *
 * DEFAULT OFF, and that is not caution for its own sake. This sits on every
 * chat turn, there is no fail-open that protects the ANSWER (a wrong route
 * degrades the reply silently, on every turn, with nothing to look at
 * afterwards), and this repository's own rule is that every constant in
 * `verbatim.ts` is a measurement — changing one without re-running
 * `bun run evals:recall` at ten repeats is how a silent regression ships.
 * So the router is built, wired and dormant until that run says it is better.
 */
export type RecallEscalationMode = "score" | "decision";

export const isRecallEscalationMode = (
  raw: string,
): raw is RecallEscalationMode => raw === "score" || raw === "decision";

/** Module-load, like `RECALL_MODE` beside it: a mode cannot change mid-turn. */
const ESCALATION_MODE: RecallEscalationMode = (() => {
  const raw = process.env["RECALL_ESCALATION"];
  return raw !== undefined && isRecallEscalationMode(raw) ? raw : "score";
})();

export const recallEscalationMode = (): RecallEscalationMode => ESCALATION_MODE;

/**
 * Below this P(the gathered material answers the message), the turn goes to
 * the judge.
 *
 * Read as: escalate unless the material clearly answers. The asymmetry is the
 * judge's cost against a bad block's cost — the judge is one cheap call on a
 * minority of turns, while a block that does not answer is served to the main
 * model as if it did, and the reply is wrong in a way nobody traces back
 * here. Starting value only; `evals:recall` settles it.
 */
const ANSWERS_THRESHOLD = 0.6;

/** How many candidate labels the question carries. Enough to see what was
 * gathered, few enough to stay a sub-second call on a turn's hot path. */
const MAX_CANDIDATE_LABELS = 8;
const LABEL_MAX_CHARS = 140;

const QUESTION_ID = "answers";

/**
 * Whether to hand this turn to the judge.
 *
 * Falls back to the score rule on ANY doubt — the mode being off, no
 * candidates to describe, a decision that did not arrive. That fallback is
 * the whole reason this is safe to switch on: the worst case is the
 * behaviour that shipped before it.
 */
export const shouldEscalate = async (params: {
  selection: VerbatimSelection;
  /** The message recall is answering. */
  message: string;
  /** Short labels for what the gather found, best first. */
  candidateLabels: string[];
}): Promise<boolean> => {
  const byScore = shouldEscalateToJudge(params.selection);
  if (ESCALATION_MODE !== "decision") return byScore;

  const labels = params.candidateLabels
    .slice(0, MAX_CANDIDATE_LABELS)
    .map((label) => label.slice(0, LABEL_MAX_CHARS))
    .filter((label) => label.trim().length > 0);
  if (labels.length === 0) return byScore;

  try {
    const response = await evaluateDecisions({
      state: {
        message: params.message,
        candidates: labels,
        bestScore: params.selection.ambiguity.bestScore,
        nearTies: params.selection.ambiguity.nearTies,
        uncorroboratedAnchors: params.selection.ambiguity.uncorroboratedAnchors,
      },
      questions: {
        [QUESTION_ID]: {
          type: "boolean",
          instructions:
            "A workspace assistant retrieved the listed items to help answer the message. Do those items actually contain what the message is asking about?",
          criteria: {
            true: "At least one item is about what the message asks. Being adjacent to the topic is not enough — it has to bear on the question.",
            false:
              "The items are unrelated to the message, or merely share vocabulary with it. Also false when the message asks for nothing retrievable at all.",
          },
        },
      },
    });
    const answer = response.answers[QUESTION_ID];
    if (answer === undefined || answer.type !== "boolean") return byScore;
    return answer.probability < ANSWERS_THRESHOLD;
  } catch {
    // `evaluateDecisions` throws `DecisionUnavailableError` when the model is
    // off, slow or broken. Nothing about that says anything about this turn,
    // so the score rule answers it.
    return byScore;
  }
};
