import { and, eq, isNull, sql } from "drizzle-orm";
import db from "../../db";
import { documents, folders } from "../../db/schema";
import type { DecisionQuestion } from "../../schemas/decisions";
import { chosenOption, decide } from "../decisions/decide";
import { redactSensitiveFacts } from "../facts/redact";
import type { FactSheet } from "../facts/types";

/**
 * Decide where a document with no expressed destination belongs.
 *
 * The case it answers: a file attached to a chat, or produced by the agent,
 * is promoted to the Drive with no folder — so it lands at the root, and the
 * root is where files go to be lost. Nobody sorts them afterwards.
 *
 * THE ASYMMETRY IS THE OPPOSITE OF THE TRIGGER GATE'S, and every number here
 * follows from that. A wrongly-filed document is worse than an unfiled one:
 * unfiled, the person sees it at the root and moves it; misfiled, they do not
 * know it exists and have nowhere to look. So this asks for a CONFIDENT
 * answer and falls back to the root on anything less — the inverse of the
 * gate, which refuses only on a confident negative.
 *
 * Run AFTER processing, never at upload: the whole value is the semantic
 * match, and the summary that makes it possible does not exist until the
 * extraction has finished. A document that sits at the root for a minute and
 * is then filed, with a banner saying so, is the intended experience.
 */

/**
 * How sure the model must be. High, per the asymmetry above — measured
 * against the chosen option's own probability, not against the field.
 */
const parseFilingThreshold = (): number => {
  const raw = process.env["DRIVE_FILING_THRESHOLD"];
  if (raw === undefined || raw === "") return 0.7;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(
      `Invalid DRIVE_FILING_THRESHOLD: "${raw}" — expected a number in [0,1].`,
    );
  }
  return parsed;
};
export const DRIVE_FILING_THRESHOLD = parseFilingThreshold();

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
 * How many folders may be offered.
 *
 * The decision model holds 32k tokens of context, and a team with hundreds of
 * folders would blow it. Capped by document count — the folders a team
 * actually uses are the folders it has put things in — and each candidate is
 * a line, so the cap is generous rather than tight.
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

/**
 * The folders a document could go in: the team's, busiest first.
 *
 * Ordering by `documentCount` is what makes the cap safe rather than
 * arbitrary. A folder nobody has filed anything in is the least likely
 * destination for the next thing, so truncating the tail costs the least
 * plausible options rather than a random sixty.
 */
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
  const criteria: Record<string, string | null> = {
    [ROOT_OPTION]:
      "None of these folders is clearly right for this document, or it does not belong in any of them. Choose this whenever the match is a guess.",
  };
  for (const candidate of candidates) {
    criteria[candidate.id] = candidate.description
      ? `${candidate.fullPath} — ${candidate.description.slice(0, DESCRIPTION_CHARS)}`
      : candidate.fullPath;
  }
  return {
    type: "choice",
    instructions:
      "A document was added to this workspace without a destination. Given what is known about it, which folder does it belong in? Choose a folder only when the document clearly belongs there; otherwise leave it unfiled.",
    criteria,
  };
};

const QUESTION_ID = "folder";

/**
 * File one processed document, or leave it where it is.
 *
 * Returns the folder it was moved to, or null for every other outcome —
 * no answer, an answer below the threshold, the root option, a folder that
 * vanished between the decision and the write. Never throws: the caller is
 * the tail of the document pipeline, and a filing that cannot be decided must
 * not fail an upload that otherwise succeeded.
 */
export const autoFileDocument = async (params: {
  documentId: string;
  teamId: string;
  organizationId: string;
  /** The whole sheet, not its facts: redaction needs the event type to know
   * which of them carry content. */
  sheet: FactSheet;
}): Promise<{ folderId: string; confidence: number | null } | null> => {
  try {
    const candidates = await listFilingCandidates({ teamId: params.teamId });
    if (candidates.length === 0) return null;

    const response = await decide({
      // Redacted HERE, at the one point a fact sheet leaves the platform —
      // the same seam the trigger gate uses. Without it
      // `FACTS_ALLOW_CONTENT_EGRESS=false` would be a setting that reads as
      // honoured and is not, which is worse than not having it.
      state: redactSensitiveFacts(params.sheet).facts,
      questions: { [QUESTION_ID]: buildFilingQuestion(candidates) },
      context: {
        teamId: params.teamId,
        organizationId: params.organizationId,
      },
    });

    const chosen = chosenOption(response, QUESTION_ID);
    if (chosen === null || chosen.choice === ROOT_OPTION) return null;
    // An unknown id means the model named something that was not offered.
    if (!candidates.some((c) => c.id === chosen.choice)) return null;
    // `null` here is an answer with no distribution behind it — not the same
    // as a low one, but not evidence of confidence either, and this decision
    // is the one that needs evidence.
    if (chosen.probability === null) return null;
    if (chosen.probability < DRIVE_FILING_THRESHOLD) return null;

    // The move and the counter in ONE transaction, like every other move
    // (`documents/update.ts`). `folders.documentCount` is not decoration: it
    // orders the filing candidates and gates the nightly describe pass, so a
    // failure between the two would skew both, permanently, with nothing to
    // recompute it from.
    const moved = await db.transaction(async (tx) => {
      // Only move a document still at the root: a person who filed it in the
      // meantime has said where it goes, and that beats any inference.
      const [row] = await tx
        .update(documents)
        .set({ folderId: chosen.choice })
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
        .where(eq(folders.id, chosen.choice));
      return true;
    });
    if (!moved) return null;

    return { folderId: chosen.choice, confidence: chosen.probability };
  } catch (error) {
    console.warn(
      `[drive.auto-file] could not file ${params.documentId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
