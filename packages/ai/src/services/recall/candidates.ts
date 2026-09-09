import type { RecordAnchor } from "@fretik/shared/services/collection-records/anchor";
import type { GraphNeighborhood } from "./graph";

/**
 * The shapes and the rendering primitives shared by the two consumers of one
 * gather: the judge prompt (`buildJudgeInput`) and the deterministic block
 * (`buildVerbatimBlock`).
 *
 * They live here rather than in `recall.ts` so the two selectors can be read —
 * and changed — side by side without importing each other, and so a rendering
 * convention (how a date is stamped, how far a candidate is clipped) has ONE
 * definition. A per-selector copy of `asOfLine` would drift the moment one of
 * them learned a new date field.
 */

/** Per-candidate clip — keeps the judge prompt ≤ ~12k chars worst case. */
export const CANDIDATE_MAX_CHARS = 700;

export interface Candidate {
  /** Provenance marker, e.g. `(episode:E1)` for the judge or `(episode:<uuid>)`. */
  marker: string;
  content: string;
}

/** Minimal structural view of a search hit — what the assembly reads. */
export interface RecallSearchHit {
  sourceType: string;
  sourceId: string;
  content: string;
  metadata: unknown;
  /** Cohere relevance ∈ [0,1]; null when the rerank stage was skipped. */
  rerankScore?: number | null;
}

export interface RecallGathered {
  anchors: RecordAnchor[];
  knowledgeResults: RecallSearchHit[];
  documentResults: RecallSearchHit[];
  graph: GraphNeighborhood | null;
  /** Capability channel — NEVER passed to the judge (see `CAPABILITY_TOP_K`). */
  capabilityResults: RecallSearchHit[];
}

/** `metadata` is `unknown` on candidates — read one string field safely. */
export const metadataString = (
  metadata: unknown,
  key: string,
): string | null => {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value: unknown = Reflect.get(metadata, key);
  return typeof value === "string" ? value : null;
};

/**
 * `As of YYYY-MM-DD` prefix for a dated candidate — the judge carries it into
 * the bullet so the agent can date the fact and pick the freshest of two
 * conflicting candidates. Empty when the candidate has no date.
 */
export const asOfLine = (isoDate: string | null): string =>
  isoDate ? `As of ${isoDate.slice(0, 10)}\n` : "";

export const renderCandidates = (
  title: string,
  candidates: Candidate[],
): string => {
  if (candidates.length === 0) return "";
  const body = candidates
    .map((c) => `${c.marker}\n${c.content.slice(0, CANDIDATE_MAX_CHARS)}`)
    .join("\n\n");
  return `## ${title}\n\n${body}\n\n`;
};
