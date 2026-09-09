import {
  asOfLine,
  type Candidate,
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
 * Abstention gate — the whole block is withheld when the BEST thing retrieval
 * found scores under this.
 *
 * Distinct from the per-candidate floors above, and the eval is what forced the
 * distinction. Those floors are RELATIVE, so they rank candidates against each
 * other and are blind to the case where the whole gather is weak: on "Salut, tu
 * vas bien aujourd'hui ?" the arms still return their top-K, the best of them
 * still clears 35% of itself, and an unrelated episode about generating CSV
 * files was injected as team memory. The judge refuses that turn by reading the
 * message; without one, the only deterministic signal is that nothing scored
 * well in absolute terms.
 *
 * Calibrated from the recall suite's own distribution rather than guessed — see
 * the `best=` field on the `[recall] mode=…` log line, which exists to keep
 * that calibration reproducible.
 *
 * Load-bearing only under `RECALL_MODE=verbatim`. In `adaptive` — the default —
 * `JUDGE_ESCALATION_BEST_SCORE` (0.7) is higher, so every gather weak enough to
 * reach this floor has already been routed to the judge, and the abstention
 * computed here is discarded. The two are not redundant: this one is the answer
 * when there is no judge to ask, and the day the escalation threshold drops
 * below it, it starts deciding turns again.
 */
const ABSTENTION_BEST_SCORE_FLOOR = 0.25;

/**
 * Per-source budgets. Deliberately tighter than the arms' top-K: the arms
 * retrieve for recall, this selects for precision, and an unbounded block is
 * the failure mode the judge's 4-bullets-per-section cap existed to prevent.
 *
 * Two per source rather than three, because the block has a 2 000-char ceiling
 * it must fit by SELECTING rather than by truncating (see
 * `HARD_BLOCK_CHAR_CAP`). Nine candidates in 2 000 chars is ~180 each, which is
 * below the judge's own 200-char bullets — i.e. it would carry less
 * information per candidate than the thing it replaces, while carrying more
 * candidates. Six is what the budget actually affords.
 */
const MAX_MEMORIES = 2;
const MAX_EPISODES = 2;
const MAX_RECORDS = 2;

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
const INCLUDE_DOCUMENTS = true;

/**
 * …but only when a document TOPS the ranking, and then only one.
 *
 * Both extremes are measured. Admitting documents freely scored 21/23 against
 * 22/23 without them: they bought the document-content case and cost
 * `rec-multi-domain`, whose Horizon record was pushed out of the shared
 * 2 000-char budget by document chunks, and left `rec-graph-link` flapping at
 * 9/10. Excluding them entirely leaves the one case where a document is the
 * only thing that answers.
 *
 * The gate is positional, exactly like the capability channel's: the document
 * must essentially beat everything memory found, which is the difference
 * between "what does the Sirius lease say about the deposit" (the lease tops
 * the ranking) and a supplier question where a lease merely shares vocabulary.
 * It is also what the prompt's own tool-routing table implies — "what a
 * document SAYS" is `searchKnowledge`'s job, mid-turn — so a document is worth
 * a pre-turn slot only when it is unmistakably the answer.
 */
const DOCUMENT_TOP_MARGIN = 0.9;
const MAX_DOCUMENTS = 2;

/**
 * Ceiling on the assembled block — the SAME budget the judge is held to (its
 * prompt targets ≤2 000 chars; `recall.ts`'s 2 400 is a runaway guard above
 * that target, not a licence).
 *
 * It was 4 000 on the first pass, reasoned from "this is not a distillation, so
 * it needs more room". That reasoning is fine and the number was still wrong:
 * it made the eval measure a judge under 2 000 against a verbatim block under
 * 4 000, which is not a comparison. A budget is part of the contract, and the
 * selector that cannot compress has to meet it by choosing fewer things.
 *
 * The honest cost of meeting it: a 1 500-char episode summary arrives clipped
 * (`clipToBudget`), and a clip is a worse compression than the judge's
 * rewrite — it keeps the opening and drops the conclusion, where a summary
 * keeps the conclusion. That asymmetry is a real argument for the judge, and it
 * is the one the size assertion surfaced.
 */
const HARD_BLOCK_CHAR_CAP = 2_000;

/**
 * Per-candidate ceiling, sized so `MAX_*` candidates plus their section headers
 * and the framing line land inside `HARD_BLOCK_CHAR_CAP` without the whole
 * block being truncated — a block-level cut can sever the last candidate's
 * provenance marker, which turns a citable id into a fabricated one.
 */
const VERBATIM_CANDIDATE_MAX_CHARS = 260;

/**
 * Clip to `max` at the last sentence or line boundary before it, so a candidate
 * ends on a complete thought rather than mid-word. Falls back to a hard cut
 * when there is no boundary in the last third — better a blunt cut than a
 * 40-char fragment.
 */
const clipToBudget = (text: string, max: number): string => {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const head = trimmed.slice(0, max);
  const boundary = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("\n"),
    head.lastIndexOf(" ; "),
  );
  return boundary > max * 0.66
    ? `${head.slice(0, boundary + 1).trim()} […]`
    : `${head.trim()} […]`;
};

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
  "Retrieved for this message, most relevant first. Some entries may not bear on it — use what does, ignore the rest. Never quote them; dig deeper via the provenance ids.";

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
  /**
   * The best rerank score anywhere in the gather, or `null` when rerank
   * degraded. Logged per turn so `ABSTENTION_BEST_SCORE_FLOOR` is calibrated
   * against a measured distribution — the reverted 2026-08 relevance gate is
   * the standing reminder that a threshold picked without one is not an
   * instrument.
   */
  bestScore: number | null;
}

export interface VerbatimSelection {
  /** The assembled block, or `null` when nothing cleared the floors. */
  block: string | null;
  /** Episode ids actually rendered — the `stampEpisodeRecall` set. */
  recalledEpisodeIds: string[];
  ambiguity: AmbiguitySignals;
}

/**
 * Below this best-score, the deterministic path hands the turn to the judge
 * (`RECALL_MODE=adaptive`).
 *
 * This is NOT the abstention floor: it is the admission that abstention is the
 * one job here with no deterministic substitute, measured rather than assumed.
 * Over 230 eval repeats the cases that must abstain and the cases that must
 * cite overlap on score — `rec-abstention-insufficient` must abstain at 0.364
 * while must-cite cases sit at the same value — so no threshold DECIDES the
 * question. What a threshold can do is SORT: it sends the weak-gather turns,
 * where the question actually arises, to the model that can read the message,
 * and keeps the confident ones on the fast path.
 *
 * Deliberately set where the routed fraction is stable rather than at the edge
 * of a cliff: from 0.50 to 0.65 the same turns route, so the number is not
 * balanced on one fixture's variance.
 */
export const JUDGE_ESCALATION_BEST_SCORE = 0.7;

/**
 * Whether this gather should be handed to the judge instead of served
 * deterministically. A `null` best means rerank degraded, so there is no
 * evidence to sort on and the candidates are unranked noise — exactly the turn
 * a model should look at rather than a threshold.
 */
export const shouldEscalateToJudge = (selection: VerbatimSelection): boolean =>
  selection.ambiguity.bestScore === null ||
  selection.ambiguity.bestScore < JUDGE_ESCALATION_BEST_SCORE;

const scoreOf = (hit: RecallSearchHit): number | null =>
  typeof hit.rerankScore === "number" ? hit.rerankScore : null;

/**
 * The best rerank score among the MEMORY candidates — the denominator of the
 * relative floor, the input to the abstention gate, and the bar a document has
 * to clear to be admitted at all.
 *
 * Knowledge only, deliberately, and the eval is what settled it. When documents
 * counted here, a lexically dominant document raised `best` for a block it
 * could not appear in: on `rec-noise-general` — a general-knowledge VAT
 * question over a corpus holding an invoice whose numbers dominate the ranking
 * — `best` oscillated 0.33 ↔ 0.90 between otherwise identical repeats, purely
 * on whether the invoice won its arm that time, and abstention became a coin
 * flip. Excluding them made the same case a stable 0.252.
 *
 * It also has to stay knowledge-only for `documentTopsRanking` to mean
 * anything: a document compared against a ceiling that already includes
 * documents is compared against itself.
 *
 * `null` when the rerank stage degraded to RRF-only (circuit breaker open,
 * provider down): no scores to compare, so the floors are skipped and the arms'
 * own top-K is served, which is what the pipeline did before reranking existed.
 * A retrieval outage must not silently empty the memory block.
 */
const bestScore = (gathered: RecallGathered): number | null => {
  let best: number | null = null;
  for (const hit of gathered.knowledgeResults) {
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
    bestScore: best,
  };
};

const renderSection = (title: string, candidates: Candidate[]): string => {
  if (candidates.length === 0) return "";
  const body = candidates
    .map(
      (c) =>
        `${c.marker}\n${clipToBudget(c.content, VERBATIM_CANDIDATE_MAX_CHARS)}`,
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

  // Abstain before selecting anything. A gather whose best hit is weak has
  // found nothing to say, and the per-candidate floors below cannot see that:
  // they are relative, so on a weak gather they happily rank noise against
  // noise. A `null` best means rerank degraded to RRF and there are no scores
  // to judge by — serve the arms' own top-K rather than go silent on a
  // provider outage.
  if (best !== null && best < ABSTENTION_BEST_SCORE_FLOOR) {
    return {
      block: null,
      recalledEpisodeIds: [],
      ambiguity: measureAmbiguity(gathered, semanticRecordIds, best),
    };
  }

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

  // A document rides only when it beats what memory found. `best` is the
  // knowledge arms' ceiling (see `bestScore`), so this compares the top
  // document against the best thing already destined for the block.
  const topDocument = gathered.documentResults[0];
  const topDocumentScore =
    topDocument === undefined ? null : scoreOf(topDocument);
  const documentTopsRanking =
    topDocumentScore !== null &&
    (best === null || topDocumentScore >= best * DOCUMENT_TOP_MARGIN);
  if (INCLUDE_DOCUMENTS && documentTopsRanking) {
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

  // Sections in DROP ORDER — least load-bearing last. The budget is enforced
  // by removing whole sections from the tail rather than by slicing the
  // assembled string: a slice lands mid-token, and the token it lands in the
  // middle of is a provenance marker, which turns a citable id into one the
  // agent will call its tools with and get nothing back. Graph goes first
  // because its lines are leads, not facts; memories go last because a
  // matching process file is the single most actionable thing here.
  const sections: string[] = [
    renderSection("FACTS — team memory:", memories),
    renderSection("EPISODES — past conversations:", episodes),
    renderSection("RECORDS:", records),
    renderSection("DOCUMENTS:", documents),
    graphLines.length > 0
      ? `GRAPH — records named in the message, and what they link to:\n\n${graphLines.join("\n")}\n`
      : "",
  ].filter((s) => s.length > 0);

  const ambiguity = measureAmbiguity(gathered, semanticRecordIds, best);

  if (sections.length === 0) {
    return { block: null, recalledEpisodeIds: [], ambiguity };
  }

  const assemble = (parts: string[]): string =>
    `${VERBATIM_HEADER}\n\n${parts.join("")}`.trim();

  const kept = [...sections];
  while (kept.length > 1 && assemble(kept).length > HARD_BLOCK_CHAR_CAP) {
    kept.pop();
  }
  const assembled = assemble(kept);
  // One section left and still over: the candidate clip already ran, so this is
  // a pathological single entry. Cut it, but cut it BEFORE the last marker so
  // nothing half-written survives as a citation.
  const block =
    assembled.length > HARD_BLOCK_CHAR_CAP
      ? `${assembled.slice(0, assembled.lastIndexOf("\n(", HARD_BLOCK_CHAR_CAP)).trim()}\n[…]`
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
