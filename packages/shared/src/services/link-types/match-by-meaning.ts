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

/** `employed_by` → `employed by`: a phrase reads, a key does not. */
const asPhrase = (key: string): string =>
  key.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Question version 2. Every option is written as the same sentence about
 * the same two records, and no option shows its inverse reading.
 *
 * Version 1 offered "owns (read the other way: is owned by)", and the model
 * took `subsidiary_of` for `owns` on the strength of that inverse — a reuse
 * that files every fact backwards, because a type is reused in ONE direction
 * only. Measured 2026-09-24 (`evals:decisions`): the inverse pick went, and
 * the true synonyms rose.
 */
export const buildLinkTypeQuestion = (
  rawKey: string,
  candidates: readonly LinkTypeCandidate[],
): DecisionQuestion => {
  const criteria: Record<string, string> = {
    [NEW_TYPE_OPTION]:
      "None of these says the same thing with the two records in the same roles.",
  };
  for (const c of candidates) {
    criteria[c.id] = `The first record ${c.label} the second record.`;
  }
  return {
    type: "choice",
    instructions: `A relation between two records was named "${rawKey}", read as: the first record ${asPhrase(rawKey)} the second record. Which existing relation says the same thing, with each record in the same role? A relation that is only true read the other way round is not the same.`,
    criteria,
  };
};

/**
 * The existing type to reuse, or null to create a new one. Reuse needs the
 * point's confidence AND a real share for the winner.
 */
export const readLinkTypeVerdict = (
  response: DecisionResponse | null,
  questionId: string,
  candidates: readonly LinkTypeCandidate[],
): { reuseId: string | null; chosenId: string | null } => {
  if (response?.status !== "answered") {
    return { reuseId: null, chosenId: null };
  }
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
  return { reuseId: chosenId !== null && sure ? chosenId : null, chosenId };
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
