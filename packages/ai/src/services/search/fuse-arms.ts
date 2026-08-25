// Type-only on purpose: this module must stay free of any database import, or
// the invariant below stops being testable without a live Postgres.
import type { AiVectorSourceType } from "@fretik/shared/db/schema";
import type { RegistryRow } from "./record-registry-search";

/**
 * Weighted-RRF fusion of the three retrieval arms — the decision half of
 * `hybridSearch`, kept apart from its IO so the one invariant that can silently
 * corrupt every ranking is testable without a database.
 *
 * That invariant is IDENTITY. Two arms are keyed on the `ai_vectors` row; the
 * third is keyed on the RECORD. A record that still carries a card therefore
 * arrives under two different ids, and merging naively would list it twice —
 * once as a card, once as a registry hit — each with a partial score. Records
 * are folded on `sourceId` for exactly that reason.
 */

/** A row as the two `ai_vectors` arms return it. */
export interface RawRow {
  id: string;
  content: string;
  contextualPrefix: string;
  metadata: unknown;
  sourceType: AiVectorSourceType;
  sourceId: string;
  chunkIndex: number;
  totalChunks: number;
  createdAt: Date;
}

export interface HybridCandidate extends RawRow {
  /** 1-based rank in the semantic list, `null` if absent from that list. */
  semanticRank: number | null;
  /** 1-based rank in the BM25 list, `null` if absent from that list. */
  bm25Rank: number | null;
  /**
   * 1-based rank in the record-registry list, `null` if absent. Only ever set
   * on `sourceType === 'records'` candidates — the arm reads no other source.
   */
  registryRank: number | null;
  /** Weighted-RRF fused score. */
  rrfScore: number;
}

export interface FuseWeights {
  semantic: number;
  bm25: number;
  registry: number;
}

/** RRF's rank discount. Rank 1 contributes half its arm's weight. */
const rrf = (rank: number): number => 1 / (rank + 1);

/**
 * Render what the registry arm matched, in the shape the reranker and the
 * citation layer already handle — the same first lines `buildRecordCard`
 * writes, so a record reads identically whether it arrived through this arm or
 * through its card.
 */
export const renderRegistryContent = (row: RegistryRow): string => {
  const lines = [`${row.typeLabel}: ${row.label}`];
  if (row.aliases.length > 0) lines.push(`Aliases: ${row.aliases.join(", ")}`);
  return lines.join("\n");
};

export const fuseArms = (input: {
  semanticRows: RawRow[];
  bm25Rows: RawRow[];
  registryRows: RegistryRow[];
  weights: FuseWeights;
  outputSize: number;
}): HybridCandidate[] => {
  const merged = new Map<string, HybridCandidate>();

  input.semanticRows.forEach((row, index) => {
    const rank = index + 1;
    merged.set(row.id, {
      ...row,
      semanticRank: rank,
      bm25Rank: null,
      registryRank: null,
      rrfScore: input.weights.semantic * rrf(rank),
    });
  });

  input.bm25Rows.forEach((row, index) => {
    const rank = index + 1;
    const delta = input.weights.bm25 * rrf(rank);
    const existing = merged.get(row.id);
    if (existing) {
      existing.bm25Rank = rank;
      existing.rrfScore += delta;
      return;
    }
    merged.set(row.id, {
      ...row,
      semanticRank: null,
      bm25Rank: rank,
      registryRank: null,
      rrfScore: delta,
    });
  });

  // Index the record cards already merged by the RECORD they describe — the
  // bridge between the two identity spaces (see the module docblock).
  const cardByRecordId = new Map<string, HybridCandidate>();
  for (const candidate of merged.values()) {
    if (candidate.sourceType === "records") {
      cardByRecordId.set(candidate.sourceId, candidate);
    }
  }

  input.registryRows.forEach((row, index) => {
    const rank = index + 1;
    const delta = input.weights.registry * rrf(rank);
    const card = cardByRecordId.get(row.recordId);
    if (card) {
      card.registryRank = rank;
      card.rrfScore += delta;
      return;
    }
    // No card — the type sits above the indexing ceiling, or the card has not
    // been built yet. This is the branch the registry arm exists for. Keyed by
    // the record id so identity stays stable across query variants, which is
    // what lets `globalMerge` accumulate a multi-variant hit instead of
    // splitting it.
    merged.set(row.recordId, {
      id: row.recordId,
      content: renderRegistryContent(row),
      contextualPrefix: "",
      metadata: {
        collection_id: row.collectionId,
        collection_key: row.collectionKey,
        label: row.label,
      },
      sourceType: "records",
      sourceId: row.recordId,
      chunkIndex: 0,
      totalChunks: 1,
      createdAt: row.createdAt,
      semanticRank: null,
      bm25Rank: null,
      registryRank: rank,
      rrfScore: delta,
    });
  });

  return [...merged.values()]
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, input.outputSize);
};
