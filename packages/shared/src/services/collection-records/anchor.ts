import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../../db";
import { collectionRecords } from "../../db/schema";
import {
  FUZZY_MATCH_THRESHOLD,
  RESOLUTION_SUGGEST_THRESHOLD,
} from "../../lib/resolution";
import { normalizeEntityName } from "../../utils/normalizeEntityName";

/** Which funnel stage produced a match — callers gate on it, not on magic
 * confidence constants (e.g. recall's graph arm drops word-only `fts` hits). */
export type AnchorMatchType = "exact" | "alias" | "fts" | "trigram";

/** One record a span of text points at, with how sure the match is. */
export interface RecordAnchor {
  recordId: string;
  collectionId: string;
  label: string;
  confidence: number;
  matchedText: string;
  matchType: AnchorMatchType;
}

const DEFAULT_MAX_ANCHORS = 5;
const MAX_SPANS = 150;
const MAX_SPAN_TOKENS = 4;
/**
 * How far below `FUZZY_MATCH_THRESHOLD` the trigram GUC is set so the `%`
 * prefilter is inclusive of rows sitting exactly on the threshold. Small
 * enough that the candidate set barely widens, large enough to survive the
 * float rounding of a `real` GUC.
 */
const TRIGRAM_PREFILTER_EPSILON = 0.001;

/**
 * Match arbitrary text spans onto the team's CONFIRMED records — the shared
 * precision funnel of the event→graph resolver and the recall pipeline. The
 * spans come from either exhaustive n-gram generation (`anchorTextToRecords`)
 * or LLM mention extraction (the async resolver); BOTH go through these same
 * set-based stages (one query per stage, never per span):
 *   1. exact `normalizedLabel`            → confidence 1.0
 *   2. alias array overlap                → confidence 1.0
 *   3. `searchVector` full-text hit       → confidence 0.9 (identifier-shaped
 *      or multi-word spans only — a lone word matching some record's field
 *      text is not evidence)
 *   4. trigram ≥ FUZZY_MATCH_THRESHOLD on `normalizedLabel` → the similarity
 * Never creates records. Deduped per record (best confidence wins), floored
 * at RESOLUTION_SUGGEST_THRESHOLD, capped at `maxAnchors`.
 *
 * Deliberately NO language-dependent filtering (stopword lists, casing
 * heuristics): user text and record data are free-form and multilingual, so
 * precision lives in the matcher's gates, not in guesses about the input. A
 * function word simply matches nothing — it costs one array slot.
 *
 * Semantic (embedding) matching is NOT here: unresolved LLM mentions get a
 * kNN pass over the record cards in `ai_vectors` once those land (P4) —
 * similarity is evidence for the `suggested` band, never an identity claim.
 */
export const matchSpansToRecords = async (input: {
  teamId: string;
  spans: string[];
  maxAnchors?: number;
}): Promise<RecordAnchor[]> => {
  const maxAnchors = input.maxAnchors ?? DEFAULT_MAX_ANCHORS;

  const normBySpan = new Map<string, string>();
  for (const s of input.spans) {
    const norm = normalizeEntityName(s) || s.toLowerCase().trim();
    if (norm.length >= 2) normBySpan.set(s, norm);
  }
  if (normBySpan.size === 0) return [];
  const norms = [...new Set(normBySpan.values())];
  const spanOfNorm = (norm: string): string =>
    [...normBySpan.entries()].find(([, n]) => n === norm)?.[0] ?? norm;

  const anchors = new Map<string, RecordAnchor>();
  const add = (a: RecordAnchor): void => {
    const prior = anchors.get(a.recordId);
    if (!prior || a.confidence > prior.confidence) anchors.set(a.recordId, a);
  };
  const done = (): RecordAnchor[] =>
    [...anchors.values()]
      .filter((a) => a.confidence >= RESOLUTION_SUGGEST_THRESHOLD)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxAnchors);

  // Stage 1 — exact normalized label.
  const exact = await db
    .select({
      id: collectionRecords.id,
      collectionId: collectionRecords.collectionId,
      label: collectionRecords.label,
      normalizedLabel: collectionRecords.normalizedLabel,
    })
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, input.teamId),
        eq(collectionRecords.status, "confirmed"),
        inArray(collectionRecords.normalizedLabel, norms),
      ),
    )
    .limit(maxAnchors * 2);
  for (const r of exact) {
    add({
      recordId: r.id,
      collectionId: r.collectionId,
      label: r.label,
      confidence: 1.0,
      matchedText: spanOfNorm(r.normalizedLabel),
      matchType: "exact",
    });
  }
  if (anchors.size >= maxAnchors) return done();

  // Stage 2 — alias overlap (one array-overlap scan for all spans).
  const aliasRows = await db
    .select({
      id: collectionRecords.id,
      collectionId: collectionRecords.collectionId,
      label: collectionRecords.label,
      aliases: collectionRecords.aliases,
    })
    .from(collectionRecords)
    .where(
      and(
        eq(collectionRecords.teamId, input.teamId),
        eq(collectionRecords.status, "confirmed"),
        sql`${collectionRecords.aliases} && ARRAY[${sql.join(
          norms.map((n) => sql`${n}`),
          sql`, `,
        )}]::text[]`,
      ),
    )
    .limit(maxAnchors * 2);
  for (const r of aliasRows) {
    const hit = (r.aliases ?? []).find((a) => norms.includes(a));
    add({
      recordId: r.id,
      collectionId: r.collectionId,
      label: r.label,
      confidence: 1.0,
      matchedText: hit ? spanOfNorm(hit) : r.label,
      matchType: "alias",
    });
  }
  if (anchors.size >= maxAnchors) return done();

  // Stage 3 — full-text over the records' searchable field text (labels +
  // text fields). Catches "the order number lives in a field" matches.
  const textSpans = [...normBySpan.keys()].filter(
    (s) => /\d/.test(s) || s.includes(" "),
  );
  if (textSpans.length > 0) {
    const spanArray = sql`ARRAY[${sql.join(
      textSpans.map((c) => sql`${c}`),
      sql`, `,
    )}]::text[]`;
    const ftRows = await db.execute<{
      id: string;
      collection_id: string;
      label: string;
      span: string;
    }>(sql`
      SELECT r.id, r.collection_id, r.label, c.span
      FROM collection_records r
      JOIN unnest(${spanArray}) AS c(span)
        ON r.search_vector @@ plainto_tsquery('simple', c.span)
      WHERE r.team_id = ${input.teamId} AND r.status = 'confirmed'
      LIMIT ${maxAnchors * 2}
    `);
    for (const r of ftRows.rows) {
      add({
        recordId: r.id,
        collectionId: r.collection_id,
        label: r.label,
        confidence: 0.9,
        matchedText: r.span,
        matchType: "fts",
      });
    }
    if (anchors.size >= maxAnchors) return done();
  }

  // Stage 4 — trigram fuzzy on the normalized label (typos, punctuation).
  //
  // The join predicate leads with `%`, NOT with `similarity(…) >= t`, and that
  // is the whole point of this shape. `idx_collection_records_normalized_label`
  // is a `gin_trgm_ops` index, and GIN can only answer the trigram OPERATORS
  // (`%`, `<%`, `LIKE`) — a bare `similarity()` call is an opaque function to
  // the planner, so the previous form scanned every confirmed record of the
  // team once per span (up to `MAX_SPANS`) and got steadily slower as a team
  // accumulated records. Same rows, index-backed.
  //
  // `%` is defined as `similarity(a, b) > pg_trgm.similarity_threshold`
  // (STRICTLY greater), so the GUC is set a hair BELOW the real bar and the
  // exact `>= FUZZY_MATCH_THRESHOLD` gate is kept in the predicate: `%`
  // narrows to a candidate set that is a superset of the wanted rows, the
  // comparison then decides. Setting the GUC to the threshold itself would
  // silently drop matches that land exactly on it.
  //
  // `SET LOCAL` (hence the transaction) rather than `set_limit()`: the pool
  // hands the same connection to unrelated queries, and a session-level
  // trigram threshold leaking out of here would change matching everywhere
  // else it is used.
  const normArray = sql`ARRAY[${sql.join(
    norms.map((n) => sql`${n}`),
    sql`, `,
  )}]::text[]`;
  const fuzzyRows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SET LOCAL pg_trgm.similarity_threshold = ${sql.raw(
        String(FUZZY_MATCH_THRESHOLD - TRIGRAM_PREFILTER_EPSILON),
      )}`,
    );
    return tx.execute<{
      id: string;
      collection_id: string;
      label: string;
      norm: string;
      sim: number;
    }>(sql`
      SELECT r.id, r.collection_id, r.label, c.norm,
             similarity(r.normalized_label, c.norm) AS sim
      FROM collection_records r
      JOIN unnest(${normArray}) AS c(norm)
        ON r.normalized_label % c.norm
       AND similarity(r.normalized_label, c.norm) >= ${FUZZY_MATCH_THRESHOLD}
      WHERE r.team_id = ${input.teamId} AND r.status = 'confirmed'
      ORDER BY sim DESC
      LIMIT ${maxAnchors * 2}
    `);
  });
  for (const r of fuzzyRows.rows) {
    add({
      recordId: r.id,
      collectionId: r.collection_id,
      label: r.label,
      confidence: Number(r.sim),
      matchedText: spanOfNorm(r.norm),
      matchType: "trigram",
    });
  }

  return done();
};

/**
 * Exhaustive n-gram span generation — NO cleverness, no case, format, or
 * language assumptions (user data and user text are both chaotic; a regex or
 * stopword list that guesses "what looks like an entity" silently misses
 * lowercase names, free-form identifiers, typos, and every non-anticipated
 * language). Every 1..4-token window ≥ 3 chars is a candidate; the matcher's
 * precision gates decide. ~50-token previews stay well under MAX_SPANS
 * across 2-4 set-based queries — cheap by construction.
 */
const generateSpans = (text: string, maxSpans: number): string[] => {
  const tokens = text
    .split(/[\s,;:!?()[\]{}<>"“”«»\n\r]+/u)
    .map((t) => t.replace(/^[.'’]+|[.'’]+$/gu, ""))
    .filter((t) => t.length > 0);

  const spans = new Set<string>();
  for (let i = 0; i < tokens.length && spans.size < maxSpans; i++) {
    for (let n = 1; n <= MAX_SPAN_TOKENS && i + n <= tokens.length; n++) {
      const span = tokens.slice(i, i + n).join(" ");
      if (span.length < 3 || span.length > 80) continue;
      spans.add(span);
    }
  }
  return [...spans].slice(0, maxSpans);
};

/**
 * Anchor free text onto the team's records via exhaustive n-gram dictionary
 * matching — the deterministic, LLM-free entry point (the async resolver's
 * zero-cost pre-pass, and the recall pipeline's graph anchor). For chaotic
 * text where lexical spans aren't enough, the resolver ALSO runs LLM mention
 * extraction and funnels those spans through `matchSpansToRecords`.
 */
export const anchorTextToRecords = async (input: {
  teamId: string;
  text: string;
  maxAnchors?: number;
  /**
   * Ceiling on the generated n-gram spans. Defaults to `MAX_SPANS` (150) —
   * the resolver's budget, where the caller is a background job and coverage
   * is worth more than milliseconds. The pre-turn recall path passes a
   * smaller one: every span widens the `unnest` join on stages 3-4, and a
   * chat message long enough to produce 150 spans is prose, where the
   * entity-bearing n-grams sit in the opening tokens rather than in the
   * hundredth window.
   */
  maxSpans?: number;
}): Promise<RecordAnchor[]> => {
  const spans = generateSpans(input.text, input.maxSpans ?? MAX_SPANS);
  if (spans.length === 0) return [];
  return matchSpansToRecords({
    teamId: input.teamId,
    spans,
    maxAnchors: input.maxAnchors,
  });
};
