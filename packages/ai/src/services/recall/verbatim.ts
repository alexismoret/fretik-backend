import {
  asOfLine,
  type Candidate,
  CANDIDATE_MAX_CHARS,
  metadataString,
  type RecallGathered,
  type RecallSearchHit,
} from "./candidates";

/**
 * Deterministic recall — the same gather, selected and rendered without an LLM.
 *
 * WHY THIS EXISTS
 *
 * The judge is the only LLM call on the critical path to a turn's first token,
 * and no comparable product has one there: ChatGPT injects pre-computed
 * summaries, Claude.ai pairs an always-present entry set with an explicit
 * search tool, Letta keeps core memory blocks in context and pages the rest,
 * Mem0 and Zep do retrieval with no generative step at all. Ours costs a full
 * generation (gpt-oss-120b at reasoning effort medium) before the model has
 * emitted a byte.
 *
 * WHAT THE JUDGE ACTUALLY DOES, AND WHAT REPLACES IT HERE
 *
 * The funnel from thousands of vectors down to ~25 candidates is already
 * LLM-free: HNSW + BM25 + registry, weighted RRF, then a Cohere cross-encoder.
 * The judge only performs the last step, 25 → ~5, and five distinct jobs
 * inside it:
 *
 *   (a) select across sources        → score floors + per-source caps below.
 *   (b) refuse a dominant but        → the same floors, plus the framing line:
 *       non-responsive candidate       these are RESULTS, not facts, and the
 *                                      main model already sorts exactly this
 *                                      out on every `searchKnowledge` call,
 *                                      where it reads 20 raw chunks unaided.
 *   (c) distil to ≤500 tokens        → deliberately dropped. Every candidate
 *                                      here is ALREADY an LLM distillation
 *                                      made at write time (an episode summary,
 *                                      a curated memory, a record card);
 *                                      re-compressing a distillation into a
 *                                      200-char bullet is lossy twice over.
 *   (d) most-recent-wins on conflict → dates are metadata: `As of` is stamped
 *                                      on every dated candidate and the model
 *                                      reads them.
 *   (e) copy provenance markers      → real ids are emitted directly. The
 *                                      handle indirection existed because the
 *                                      judge mangled uuids; nothing transcribes
 *                                      them here, so nothing can corrupt them.
 *
 * The one job with no deterministic equivalent is the judge's genuine-reference
 * test ("does the sentence still read naturally with this name as an ordinary
 * word?"), which is what stops the project record `Horizon` from being injected
 * into a question about investment horizons. `keepAnchor` replaces it with
 * corroboration rather than judgment: a NAME-exact match (`exact` / `alias`)
 * stands on its own, while a merely lexical one (`fts` / `trigram`) must also
 * be found by the semantic arm — two independent retrievers agreeing on the
 * same record, which a homonym used as a common word does not produce.
 *
 * WHAT IS NOT CLAIMED
 *
 * That this is strictly better. On clear-cut turns it should be at least as
 * good — more faithful, since nothing is re-compressed — and on genuinely
 * ambiguous ones it will be noisier than the judge. `measureAmbiguity` counts
 * exactly those turns without acting on them, so the question "should the judge
 * come back for the hard cases only" gets answered with data.
 */

/**
 * Candidates must reach this fraction of the best rerank score in the gather.
 *
 * Relative, not absolute, because Cohere's scores are query-dependent and not
 * comparable across queries — a hardcoded threshold is not a valid instrument
 * (the same reason the 2026-08 relevance gate was reverted rather than tuned).
 * What IS comparable within one query is the spread: a candidate a third as
 * relevant as the best one is not the same kind of answer.
 */
const RELATIVE_SCORE_FLOOR = 0.35;

/**
 * Absolute floor under the relative one, for the case the relative test cannot
 * see: a query where NOTHING is relevant, where the best score is itself near
 * zero and every candidate then clears 35% of near-zero.
 */
const ABSOLUTE_SCORE_FLOOR = 0.02;

/**
 * Per-source budgets. Deliberately tighter than the arms' top-K: the arms
 * retrieve for recall, this selects for precision, and an unbounded block is
 * the failure mode the judge's 4-bullets-per-section cap existed to prevent.
 */
const MAX_MEMORIES = 3;
const MAX_EPISODES = 3;
const MAX_RECORDS = 3;

/**
 * Documents do not enter the pre-turn block.
 *
 * They are the noisiest arm — the reverted relevance gate measured the
 * documents arm returning its full top-K of irrelevant chunks on a supplier
 * follow-up (an invoice, a purchasing charter, a CVE bulletin, and a lease
 * twice) — and they are the one source the agent reliably fetches on its own:
 * "what a document SAYS" is the first row of the prompt's tool-routing table
 * and points at `searchKnowledge`, which searches the same index with the same
 * reranker, mid-turn, after the first token.
 *
 * Kept as a constant rather than deleted code: whether a document chunk earns
 * its place pre-turn is exactly the sort of question the eval suite can answer,
 * and flipping this is the whole experiment.
 */
const INCLUDE_DOCUMENTS = false;
const MAX_DOCUMENTS = 2;

/**
 * Ceiling on the assembled block. Higher than the judge's 2 400 because this
 * one is not a distillation: it carries whole (already-distilled) candidates.
 * Roughly 1 000 tokens worst case, against a system prompt an order of
 * magnitude larger.
 */
const HARD_BLOCK_CHAR_CAP = 4_000;

/** Two candidates of the same source closer than this are a coin flip. */
const NEAR_TIE_DELTA = 0.05;

/**
 * Score band where retrieval is neither confident nor silent. Below it the
 * floors drop everything; above it the top candidate is unambiguous.
 */
const GREY_ZONE_LO = 0.15;
const GREY_ZONE_HI = 0.45;

/**
 * The framing line. Load-bearing, and the reason the same block can be served
 * without a judge: it changes what the model believes it is reading.
 *
 * The judge's output is asserted content — the prompt tells the agent to apply
 * it silently, so a weak bullet is read as a fact about the team. These are
 * retrieval results with their scores implied by their order, which is the
 * shape the model already handles correctly twenty chunks at a time via
 * `searchKnowledge`. "May contain items that are not relevant" is not a hedge;
 * it is the instruction that makes a false positive cost nothing.
 */
const VERBATIM_HEADER =
  "Retrieved for this message, most relevant first — team memory, past conversations, and records. Some entries may not be relevant: use what bears on the message and ignore the rest. Never quote these verbatim to the user; dig deeper with the provenance ids via `searchKnowledge` / `getRecord` / `memory`.";

export interface AmbiguitySignals {
  /**
   * Lexical anchors (`fts` / `trigram`) the semantic arm did not corroborate —
   * dropped by `keepAnchor`. A non-zero count is a turn where the judge's
   * genuine-reference test would have had something to decide.
   */
  uncorroboratedAnchors: number;
  /** Same-source candidates within `NEAR_TIE_DELTA` of each other at the head. */
  nearTies: number;
  /** True when the best score in the gather sits in the grey band. */
  greyZone: boolean;
}

export interface VerbatimSelection {
  /** The assembled block, or `null` when nothing cleared the floors. */
  block: string | null;
  /** Episode ids actually rendered — the `stampEpisodeRecall` set. */
  recalledEpisodeIds: string[];
  ambiguity: AmbiguitySignals;
}

const scoreOf = (hit: RecallSearchHit): number | null =>
  typeof hit.rerankScore === "number" ? hit.rerankScore : null;

/**
 * The best rerank score anywhere in the gather — the denominator of the
 * relative floor. `null` when the rerank stage degraded to RRF-only (circuit
 * breaker open, provider down), in which case there are no scores to compare
 * and the floors are skipped entirely: serving the arms' own top-K unfiltered
 * is what the pipeline did before reranking existed, and a retrieval outage
 * must not silently empty the memory block.
 */
const bestScore = (gathered: RecallGathered): number | null => {
  let best: number | null = null;
  for (const hit of [
    ...gathered.knowledgeResults,
    ...gathered.documentResults,
  ]) {
    const score = scoreOf(hit);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
};

/**
 * Whether a hit clears the floors. A hit with no score (rerank skipped for
 * this candidate) passes: absence of evidence is not evidence of irrelevance,
 * and the per-source caps still bound how many get through.
 */
const clearsFloor = (hit: RecallSearchHit, best: number | null): boolean => {
  const score = scoreOf(hit);
  if (score === null || best === null) return true;
  return score >= Math.max(ABSOLUTE_SCORE_FLOOR, best * RELATIVE_SCORE_FLOOR);
};

/**
 * The anchor gate — corroboration in place of the judge's genuine-reference
 * test.
 *
 * `exact` and `alias` matched the record's NAME in full, which a word used in
 * its ordinary sense does not do by accident. `fts` matched somewhere in the
 * record's FIELD text and `trigram` matched approximately, so either can fire
 * on a homonym; those need the semantic arm to have independently surfaced the
 * same record. Two retrievers built on different representations agreeing is
 * evidence; one lexical hit is a coincidence waiting to be injected.
 */
const keepAnchor = (
  matchType: string,
  recordId: string,
  semanticRecordIds: Set<string>,
): boolean =>
  matchType === "exact" ||
  matchType === "alias" ||
  semanticRecordIds.has(recordId);

/** Count what a judge would have had to adjudicate, without adjudicating it. */
const measureAmbiguity = (
  gathered: RecallGathered,
  semanticRecordIds: Set<string>,
  best: number | null,
): AmbiguitySignals => {
  const uncorroboratedAnchors = (gathered.graph?.perAnchor ?? []).filter(
    (anchor) =>
      !keepAnchor(anchor.matchType, anchor.recordId, semanticRecordIds),
  ).length;

  let nearTies = 0;
  const bySource = new Map<string, number[]>();
  for (const hit of gathered.knowledgeResults) {
    const score = scoreOf(hit);
    if (score === null) continue;
    const list = bySource.get(hit.sourceType) ?? [];
    list.push(score);
    bySource.set(hit.sourceType, list);
  }
  for (const scores of bySource.values()) {
    const sorted = [...scores].sort((a, b) => b - a);
    const [first, second] = sorted;
    if (first !== undefined && second !== undefined) {
      if (first - second < NEAR_TIE_DELTA) nearTies += 1;
    }
  }

  return {
    uncorroboratedAnchors,
    nearTies,
    greyZone: best !== null && best >= GREY_ZONE_LO && best <= GREY_ZONE_HI,
  };
};

const renderSection = (title: string, candidates: Candidate[]): string => {
  if (candidates.length === 0) return "";
  const body = candidates
    .map(
      (c) => `${c.marker}\n${c.content.slice(0, CANDIDATE_MAX_CHARS).trim()}`,
    )
    .join("\n\n");
  return `${title}\n\n${body}\n\n`;
};

/**
 * Select and render the gather into the `<active_memory>` block, deterministically.
 *
 * Ordering inside each section is the reranker's, unchanged — it IS the
 * relevance signal, and re-sorting on anything else would discard the only
 * cross-source calibration the pipeline has.
 */
export const buildVerbatimBlock = (
  gathered: RecallGathered,
): VerbatimSelection => {
  const best = bestScore(gathered);

  // Records the SEMANTIC arm found — the second signal `keepAnchor` needs.
  const semanticRecordIds = new Set(
    gathered.knowledgeResults
      .filter((hit) => hit.sourceType === "records")
      .map((hit) => hit.sourceId),
  );

  const memories: Candidate[] = [];
  const episodes: Candidate[] = [];
  const records: Candidate[] = [];
  const documents: Candidate[] = [];
  const renderedEpisodeIds = new Set<string>();

  // Graph-anchored episodes first and unconditionally: they reached us because
  // a record NAMED in the message links to them, which is stronger evidence
  // than any similarity score, and they carry their own anchor labels.
  for (const episode of gathered.graph?.episodes ?? []) {
    if (episodes.length >= MAX_EPISODES) break;
    renderedEpisodeIds.add(episode.id);
    const linked =
      episode.anchorLabels.length > 0
        ? `Linked records: ${episode.anchorLabels.join(", ")}\n`
        : "";
    episodes.push({
      marker: `(episode:${episode.id})`,
      content: `${linked}${asOfLine(episode.occurredTo?.toISOString() ?? null)}${episode.title}\n${episode.summary}`,
    });
  }

  for (const hit of gathered.knowledgeResults) {
    if (!clearsFloor(hit, best)) continue;
    if (hit.sourceType === "memories" && memories.length < MAX_MEMORIES) {
      const path = metadataString(hit.metadata, "path") ?? hit.sourceId;
      memories.push({ marker: `(memory:${path})`, content: hit.content });
    } else if (
      hit.sourceType === "episodes" &&
      episodes.length < MAX_EPISODES
    ) {
      if (renderedEpisodeIds.has(hit.sourceId)) continue;
      renderedEpisodeIds.add(hit.sourceId);
      const dated = asOfLine(metadataString(hit.metadata, "occurred_to"));
      episodes.push({
        marker: `(episode:${hit.sourceId})`,
        content: `${dated}${hit.content}`,
      });
    } else if (hit.sourceType === "records" && records.length < MAX_RECORDS) {
      records.push({
        marker: `(record:${hit.sourceId})`,
        content: hit.content,
      });
    }
  }

  if (INCLUDE_DOCUMENTS) {
    for (const hit of gathered.documentResults) {
      if (documents.length >= MAX_DOCUMENTS) break;
      if (!clearsFloor(hit, best)) continue;
      const name = metadataString(hit.metadata, "file_name");
      documents.push({
        marker: `(document:${hit.sourceId})`,
        content: `${name ? `File: ${name}\n` : ""}${hit.content}`,
      });
    }
  }

  const graphLines = (gathered.graph?.perAnchor ?? [])
    .filter((anchor) =>
      keepAnchor(anchor.matchType, anchor.recordId, semanticRecordIds),
    )
    .flatMap((anchor) => anchor.lines);

  const sections =
    renderSection("FACTS — team memory:", memories) +
    renderSection("EPISODES — past conversations:", episodes) +
    renderSection("RECORDS:", records) +
    renderSection("DOCUMENTS:", documents) +
    (graphLines.length > 0
      ? `GRAPH — records named in the message, and what they link to:\n\n${graphLines.join("\n")}\n`
      : "");

  const ambiguity = measureAmbiguity(gathered, semanticRecordIds, best);

  if (sections.trim().length === 0) {
    return { block: null, recalledEpisodeIds: [], ambiguity };
  }

  const assembled = `${VERBATIM_HEADER}\n\n${sections}`.trim();
  const block =
    assembled.length > HARD_BLOCK_CHAR_CAP
      ? `${assembled.slice(0, HARD_BLOCK_CHAR_CAP)}\n…`
      : assembled;

  return {
    block,
    // Only episodes that survived into the block count as recalled — the
    // stamping set drives the demotion GC, and an episode the agent never saw
    // must not look used.
    recalledEpisodeIds: [...renderedEpisodeIds].filter((id) =>
      block.includes(`(episode:${id})`),
    ),
    ambiguity,
  };
};
