import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../../db";
import { documents, folders } from "../../db/schema";
import { decisionPoint } from "../../decisions/points";
import { chosenOf, minChosenFor, thresholdFor } from "../../decisions/policy";
import { deleteKeysByPrefix } from "../../lib/redis";
import type {
  DecisionQuestion,
  DecisionResponse,
} from "../../schemas/decisions";
import { recordDecisions, type JournalEntry } from "../decisions/journal";
import { remoteEvaluator, type DecisionEvaluator } from "../decisions/remote";
import type { FactSheet } from "../facts/types";

/**
 * Decide where a document with no expressed destination belongs.
 *
 * The case it answers: a file attached to a chat, or produced by the agent,
 * is promoted to the Drive with no folder — so it lands at the root, and the
 * root is where files go to be lost. Nobody sorts them afterwards.
 *
 * The folder's own DESCRIPTION is the policy. A person, or the assistant
 * through `manageDrive`, says what a folder is for, and the model judges the
 * document against those sentences — nothing to configure elsewhere, and the
 * reason a document went where it went is readable on the folder itself.
 *
 * THE ASYMMETRY IS THE OPPOSITE OF THE TRIGGER GATE'S. A wrongly-filed
 * document is worse than an unfiled one: unfiled, the person sees it at the
 * root and moves it; misfiled, they do not know it exists and have nowhere to
 * look. So this asks for a CONFIDENT answer (the registry's `folder` family)
 * and leaves the document alone on anything less.
 *
 * Run AFTER processing, never at upload: the whole value is the semantic
 * match, and the summary that makes it possible does not exist until the
 * extraction has finished.
 */

export const FILING_POINT = "drive.file";

/**
 * The option meaning "leave it at the root".
 *
 * An explicit option, not the absence of one. A `choice` question always
 * returns one of its options, so without this the model would be FORCED to
 * name a folder for a document that belongs in none — and being forced to
 * choose is how everything ends up somewhere wrong.
 */
export const ROOT_OPTION = "__root__";

/**
 * How many folders may be offered. Capped by document count — the folders a
 * team actually uses are the folders it has put things in — so truncating the
 * tail drops the least plausible options rather than a random sixty. Sixty
 * candidates at a line each sit comfortably inside the model's context.
 */
const MAX_CANDIDATES = 60;
/** Descriptions are capped at generation; this is the belt to that braces. */
const DESCRIPTION_CHARS = 220;

export interface FilingCandidate {
  id: string;
  name: string;
  fullPath: string;
  description: string | null;
}

export const listFilingCandidates = async (params: {
  teamId: string;
}): Promise<FilingCandidate[]> =>
  db.query.folders.findMany({
    where: { teamId: params.teamId },
    columns: { id: true, name: true, fullPath: true, description: true },
    orderBy: { documentCount: "desc" },
    limit: MAX_CANDIDATES,
  });

/**
 * The question: which of these folders, or none of them.
 *
 * A candidate with no description still appears, described by its path — a
 * folder called `/Accounting/Invoices 2026` says plenty on its own, and
 * withholding it until the nightly pass has written it a sentence would make
 * the feature useless on a fresh workspace.
 */
export const buildFilingQuestion = (
  candidates: readonly FilingCandidate[],
): DecisionQuestion => {
  const criteria: Record<string, string> = {
    [ROOT_OPTION]:
      "None of these folders is clearly right for this document, or it belongs in none of them.",
  };
  for (const candidate of candidates) {
    criteria[candidate.id] = candidate.description
      ? `${candidate.fullPath}: ${candidate.description.slice(0, DESCRIPTION_CHARS)}`
      : candidate.fullPath;
  }
  return {
    type: "choice",
    instructions:
      "A document was added to a workspace with no destination. Which folder, as described, holds documents like this one?",
    criteria,
  };
};

export const FILING_QUESTION_ID = "folder";

export type FilingVerdict =
  | {
      file: true;
      folderId: string;
      confidence: number;
      probability: number;
    }
  | {
      file: false;
      reason:
        | "unreachable"
        | "skipped"
        | "no_answer"
        | "root"
        | "unknown_option"
        | "no_confidence"
        | "below_threshold"
        | "shadow";
      confidence?: number;
      probability?: number;
      folderId?: string;
    };

/**
 * Read the answer into a filing, or a reason not to file.
 *
 * Every reason is a way of leaving the document exactly where it is, which is
 * always safe. Three are worth naming. A MISSING confidence (the gateway does
 * not report one) is not a low one — but it is not evidence of certainty
 * either, and this is the decision that needs evidence, so it does not file.
 * The chosen option must also carry a real share of the probability: a
 * confident distribution over two near-identical folders can still pick the
 * wrong twin. And `shadow` files nothing while recording what it would have
 * done.
 */
export const readFilingVerdict = (
  response: DecisionResponse | null,
  candidates: readonly FilingCandidate[],
): FilingVerdict => {
  if (response === null) return { file: false, reason: "unreachable" };
  if (response.status === "skipped") return { file: false, reason: "skipped" };

  const chosen = chosenOf(response.answers[FILING_QUESTION_ID]);
  if (chosen === null) return { file: false, reason: "no_answer" };
  const scores = {
    ...(chosen.confidence !== null ? { confidence: chosen.confidence } : {}),
    ...(chosen.probability !== null ? { probability: chosen.probability } : {}),
  };
  if (chosen.choice === ROOT_OPTION) {
    return { file: false, reason: "root", ...scores };
  }
  if (!candidates.some((c) => c.id === chosen.choice)) {
    return { file: false, reason: "unknown_option", ...scores };
  }
  if (chosen.confidence === null || chosen.probability === null) {
    return {
      file: false,
      reason: "no_confidence",
      folderId: chosen.choice,
      ...scores,
    };
  }

  const threshold = thresholdFor(response.policy, FILING_QUESTION_ID) ?? 1;
  const minChosen = minChosenFor(response.policy, FILING_QUESTION_ID) ?? 0;
  if (chosen.confidence < threshold || chosen.probability < minChosen) {
    return {
      file: false,
      reason: "below_threshold",
      folderId: chosen.choice,
      ...scores,
    };
  }
  if (response.policy.mode === "shadow") {
    return {
      file: false,
      reason: "shadow",
      folderId: chosen.choice,
      ...scores,
    };
  }
  return {
    file: true,
    folderId: chosen.choice,
    confidence: chosen.confidence,
    probability: chosen.probability,
  };
};

/**
 * Move a document that is still at the root. False when it is not: a person
 * who filed it in the meantime has said where it goes, and that beats any
 * inference.
 *
 * The move and the counter in ONE transaction, like every other move
 * (`documents/update.ts`). `folders.documentCount` orders the filing
 * candidates and gates the nightly describe pass; a failure between the two
 * would skew both, permanently.
 */
const moveFromRoot = async (params: {
  documentId: string;
  teamId: string;
  folderId: string;
}): Promise<boolean> => {
  const moved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(documents)
      .set({ folderId: params.folderId })
      .where(
        and(
          eq(documents.id, params.documentId),
          eq(documents.teamId, params.teamId),
          isNull(documents.folderId),
        ),
      )
      .returning({ id: documents.id });
    if (!row) return false;

    await tx
      .update(folders)
      .set({ documentCount: sql`${folders.documentCount} + 1` })
      .where(eq(folders.id, params.folderId));
    return true;
  });
  // The cached details still say "root" otherwise, for as long as they live.
  if (moved) await deleteKeysByPrefix(`document:${params.documentId}`);
  return moved;
};

/** Verdict reasons that mean the model never answered, as opposed to an
 * answer that said "leave it". */
const FELL_OPEN_REASONS = new Set(["unreachable", "skipped", "no_answer"]);

/**
 * The journal row for one filing decision. Pure, so its mapping is tested
 * without a database.
 *
 * `applied` is whether the verdict CHANGED what happened: a filing that
 * moved the document, or a considered "leave it". It is false for a shadow
 * verdict, for a fall-open, and for a filing that lost the race to a person
 * who moved the document first.
 */
export const filingJournalEntry = (params: {
  documentId: string;
  teamId: string;
  organizationId: string;
  response: DecisionResponse | null;
  candidates: readonly FilingCandidate[];
  verdict: FilingVerdict;
  moved: boolean;
}): JournalEntry => {
  const { response, verdict } = params;
  const answered = response?.status === "answered" ? response : null;
  const chosen = chosenOf(answered?.answers[FILING_QUESTION_ID]);
  const isCandidate =
    chosen !== null && params.candidates.some((c) => c.id === chosen.choice);

  const base = {
    organizationId: params.organizationId,
    teamId: params.teamId,
    point: FILING_POINT,
    family: FILING_QUESTION_ID,
    questionId: FILING_QUESTION_ID,
    questionVersion:
      answered?.policy.questionVersion ??
      decisionPoint(FILING_POINT).questionVersion,
    subjectType: "document",
    subjectId: params.documentId,
    targetId: isCandidate ? chosen.choice : null,
    probability: chosen?.probability ?? null,
    confidence: chosen?.confidence ?? null,
    choice: chosen?.choice ?? null,
    threshold: answered
      ? (thresholdFor(answered.policy, FILING_QUESTION_ID) ?? null)
      : null,
    transport: answered?.transport ?? null,
    modelId: answered?.modelId ?? null,
    latencyMs: answered?.latencyMs ?? null,
    costUsd: answered?.costUsd ?? null,
  };

  if (verdict.file) {
    return params.moved
      ? { ...base, outcome: "filed", applied: true, reason: null }
      : { ...base, outcome: "left", applied: false, reason: "moved_meanwhile" };
  }
  if (FELL_OPEN_REASONS.has(verdict.reason)) {
    const missing = answered?.missing.find((m) => m.id === FILING_QUESTION_ID);
    const reason =
      response?.status === "skipped"
        ? response.reason
        : (missing?.reason ?? verdict.reason);
    return { ...base, outcome: "fell_open", applied: false, reason };
  }
  return {
    ...base,
    outcome: "left",
    applied: verdict.reason !== "shadow",
    reason: verdict.reason,
  };
};

/**
 * File one processed document, or leave it where it is.
 *
 * Returns the folder it was moved to, or null for every other outcome. Never
 * throws: the caller is the tail of the document pipeline, and a filing that
 * cannot be decided must not fail an upload that otherwise succeeded.
 */
export const autoFileDocument = async (params: {
  documentId: string;
  teamId: string;
  organizationId: string;
  sheet: FactSheet;
  evaluator?: DecisionEvaluator;
}): Promise<{ folderId: string; confidence: number } | null> => {
  try {
    const candidates = await listFilingCandidates({ teamId: params.teamId });
    if (candidates.length === 0) return null;

    // The whole sheet goes: the engine cuts it to the point's allow-list
    // (summary, filename, mentions, language) and drops content when content
    // may not leave, for this caller and every other.
    const response = await (params.evaluator ?? remoteEvaluator)(
      {
        point: FILING_POINT,
        subject: { type: "document", id: params.documentId },
        sessionId: `documents:${params.documentId}`,
        state: params.sheet.facts,
        questions: { [FILING_QUESTION_ID]: buildFilingQuestion(candidates) },
      },
      { teamId: params.teamId, organizationId: params.organizationId },
    );

    const verdict = readFilingVerdict(response, candidates);
    const moved = verdict.file
      ? await moveFromRoot({
          documentId: params.documentId,
          teamId: params.teamId,
          folderId: verdict.folderId,
        })
      : false;

    // Every decision is journaled, the ones that left the document alone
    // included: a document left at the root and filed by hand a day later is
    // the label that says whether the bar was too high.
    await recordDecisions([
      filingJournalEntry({
        documentId: params.documentId,
        teamId: params.teamId,
        organizationId: params.organizationId,
        response,
        candidates,
        verdict,
        moved,
      }),
    ]);

    if (!verdict.file || !moved) return null;
    return { folderId: verdict.folderId, confidence: verdict.confidence };
  } catch (error) {
    console.warn(
      `[drive.auto-file] could not file ${params.documentId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
