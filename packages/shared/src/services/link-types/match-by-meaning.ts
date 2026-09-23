import { chosenOf, minChosenFor, thresholdFor } from "../../decisions/policy";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "../../schemas/decisions";
import type { JournalEntry } from "../decisions/journal";
import { answerJournalEntry } from "../decisions/journal-entry";

/**
 * The relation canonicalizer's last stage, before it creates a new type:
 * does this name MEAN one the team already has?
 *
 * Key and spelling matches catch `works-for` for `works_for`; nothing catches
 * `employed_by` for `works_for`, and every miss becomes one more relation
 * type the graph splits its facts across. The decision model reads the
 * proposed name against the labels of the relation types in scope and picks
 * one, or "none of these".
 */

export const LINK_TYPE_POINT = "graph.link-type-match";
export const NEW_TYPE_OPTION = "__new__";

export interface LinkTypeCandidate {
  id: string;
  label: string;
  inverseLabel: string | null;
}

/** Relation types offered at most: a source collection has a handful. */
export const MAX_LINK_TYPE_CANDIDATES = 40;

export const linkTypeQuestionId = (normalizedKey: string): string =>
  `type:${normalizedKey}`;

export const buildLinkTypeQuestion = (
  rawKey: string,
  candidates: readonly LinkTypeCandidate[],
): DecisionQuestion => {
  const criteria: Record<string, string> = {
    [NEW_TYPE_OPTION]:
      "None of these relations means the same thing as the proposed one.",
  };
  for (const c of candidates) {
    criteria[c.id] = c.inverseLabel
      ? `${c.label} (read the other way: ${c.inverseLabel})`
      : c.label;
  }
  return {
    type: "choice",
    instructions: `A relation between two records was named "${rawKey}". Which existing relation type means the same thing, in the same direction?`,
    criteria,
  };
};

/**
 * The existing type to reuse, or null to create a new one. Reuse needs the
 * point's confidence AND a real share for the winner; shadow reuses nothing.
 */
export const readLinkTypeVerdict = (
  response: DecisionResponse | null,
  questionId: string,
  candidates: readonly LinkTypeCandidate[],
): { reuseId: string | null; chosenId: string | null; shadow: boolean } => {
  if (response?.status !== "answered") {
    return { reuseId: null, chosenId: null, shadow: false };
  }
  const shadow = response.policy.mode === "shadow";
  const chosen = chosenOf(response.answers[questionId]);
  const chosenId =
    chosen && candidates.some((c) => c.id === chosen.choice)
      ? chosen.choice
      : null;
  const bar = thresholdFor(response.policy, questionId) ?? 1;
  const minChosen = minChosenFor(response.policy, questionId) ?? 0;
  const sure =
    chosen?.confidence !== null &&
    chosen?.confidence !== undefined &&
    chosen.confidence >= bar &&
    (chosen.probability ?? 0) >= minChosen;
  return {
    reuseId: chosenId !== null && sure && !shadow ? chosenId : null,
    chosenId,
    shadow,
  };
};

export const linkTypeJournalEntry = (params: {
  organizationId: string;
  teamId: string;
  fromCollectionId: string;
  questionId: string;
  response: DecisionResponse | null;
  chosenId: string | null;
  reusedId: string | null;
  /** What the legacy path did: created a type (`__new__`). */
  legacyCreated: boolean;
}): JournalEntry =>
  answerJournalEntry({
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: LINK_TYPE_POINT,
    questionId: params.questionId,
    subjectType: "collection",
    subjectId: params.fromCollectionId,
    targetId: params.chosenId,
    response: params.response,
    questionCount: 1,
    outcome: params.reusedId !== null ? "reused" : "created",
    applied: params.reusedId !== null,
    ...(params.legacyCreated ? { legacyLabel: NEW_TYPE_OPTION } : {}),
  });
