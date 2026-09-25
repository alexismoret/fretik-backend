import { probabilityOf, thresholdFor } from "../../decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "../../schemas/decisions";
import type { JournalEntry } from "../decisions/journal";
import { answerJournalEntry } from "../decisions/journal-entry";
import type { RecordAnchor } from "./anchor";

/**
 * The resolver's second opinion on its review band.
 *
 * A mention matched between the suggest and the auto thresholds becomes a
 * `suggested` link, and nothing ever reviews those: they sit outside the
 * graph the recall and the relation pass trust. The decision model reads the
 * text and answers, per record, "is this the record the text means?". A
 * confident yes promotes the link, a confident no drops it, and anything in
 * between leaves it exactly as the resolver had it.
 *
 * Asked by the jobs resolver (`workers/memory-resolve.ts`); here so the
 * decision evals ask and read it word for word. Changing the wording bumps the
 * point's `questionVersion` in `decisions/points.ts`.
 */

export const VERIFY_POINT = "memory.resolve.verify";

export const anchorQuestionId = (recordId: string): string => `anc:${recordId}`;

/**
 * Question version 2: it asks about the WORDS the resolver matched, and
 * names what else they could be. Version 1 asked whether the text referred
 * to "this specific record" and hedged on plain references (0.76–0.85 for a
 * supplier named by its short name) while leaving ordinary words just above
 * the drop bar (0.11–0.12 for "summit", "orange"). Measured 2026-09-24,
 * `evals:decisions`.
 */
export const buildAnchorQuestion = (
  anchor: RecordAnchor,
  collectionName: string | null,
): DecisionQuestion => ({
  type: "boolean",
  instructions: [
    `Record: "${anchor.label}"${collectionName ? ` (${collectionName})` : ""}.`,
    `The text contains "${anchor.matchedText}".`,
    "Does the text refer to this record?",
  ].join("\n"),
  criteria: {
    true: "The text refers to this record.",
    false: `The text uses "${anchor.matchedText}" as an ordinary word, or for someone or something else.`,
  },
});

export type AnchorVerdict = "confirm" | "drop" | "keep";

/**
 * The band read against the echoed bar: confirm at or above it, drop at or
 * below one minus it. No answer, or anything in between, keeps the link as
 * the resolver scored it.
 */
export const readAnchorVerdicts = (
  response: DecisionResponse | null,
  recordIds: readonly string[],
): Map<string, AnchorVerdict> => {
  const verdicts = new Map<string, AnchorVerdict>();
  const answered = response?.status === "answered" ? response : null;
  for (const recordId of recordIds) {
    const id = anchorQuestionId(recordId);
    const p = probabilityOf(answered?.answers[id]);
    const bar = answered ? thresholdFor(answered.policy, id) : undefined;
    // Rounded like every bar: `1 - 0.9` is 0.0999…, and an answer of 0.10
    // (answers come in hundredths) must land ON the lower bar, not above it.
    const dropBar =
      bar === undefined ? undefined : Math.round((1 - bar) * 100) / 100;
    verdicts.set(
      recordId,
      p === null || bar === undefined || dropBar === undefined
        ? "keep"
        : p >= bar
          ? "confirm"
          : p <= dropBar
            ? "drop"
            : "keep",
    );
  }
  return verdicts;
};

export const anchorJournalEntries = (params: {
  organizationId: string;
  teamId: string;
  eventId: string;
  response: DecisionResponse | null;
  verdicts: ReadonlyMap<string, AnchorVerdict>;
}): JournalEntry[] =>
  [...params.verdicts.entries()].map(([recordId, verdict]) =>
    answerJournalEntry({
      organizationId: params.organizationId,
      teamId: params.teamId,
      point: VERIFY_POINT,
      questionId: anchorQuestionId(recordId),
      subjectType: "domain_event",
      subjectId: params.eventId,
      targetId: recordId,
      response: params.response,
      questionCount: params.verdicts.size,
      outcome: verdict,
      applied: verdict !== "keep",
    }),
  );
