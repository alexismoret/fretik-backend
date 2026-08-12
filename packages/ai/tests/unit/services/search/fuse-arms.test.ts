import { describe, expect, test } from "bun:test";
import {
  fuseArms,
  type RawRow,
} from "../../../../src/services/search/fuse-arms";
import type { RegistryRow } from "../../../../src/services/search/record-registry-search";

/**
 * The registry arm reads `object_records`, while the two vector arms read
 * `ai_vectors` — two identity spaces for the same underlying record. Fusion is
 * where that has to be reconciled, and getting it wrong is silent: a record
 * would be listed twice, each copy carrying a fraction of its true score, and
 * both would compete for the 50 slots that reach the reranker.
 *
 * No database is involved here on purpose — that is the whole reason the
 * fusion was split out of `hybridSearch`.
 */

const WEIGHTS = { semantic: 0.8, bm25: 0.2, registry: 0.2 };

const vectorRow = (input: {
  id: string;
  sourceType?: RawRow["sourceType"];
  sourceId: string;
}): RawRow => ({
  id: input.id,
  content: "content",
  contextualPrefix: "prefix",
  metadata: {},
  sourceType: input.sourceType ?? "documents",
  sourceId: input.sourceId,
  chunkIndex: 0,
  totalChunks: 1,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

const registryRow = (recordId: string, label = "ACME"): RegistryRow => ({
  recordId,
  label,
  aliases: [],
  objectTypeId: "type-1",
  typeKey: "company",
  typeLabel: "Company",
  createdAt: new Date("2026-01-01T00:00:00Z"),
});

const fuse = (input: {
  semanticRows?: RawRow[];
  bm25Rows?: RawRow[];
  registryRows?: RegistryRow[];
}) =>
  fuseArms({
    semanticRows: input.semanticRows ?? [],
    bm25Rows: input.bm25Rows ?? [],
    registryRows: input.registryRows ?? [],
    weights: WEIGHTS,
    outputSize: 50,
  });

describe("fuseArms — a record never appears twice", () => {
  test("a registry hit folds into the record's existing card", () => {
    const card = vectorRow({
      id: "vector-uuid",
      sourceType: "records",
      sourceId: "record-1",
    });
    const fused = fuse({
      semanticRows: [card],
      registryRows: [registryRow("record-1")],
    });

    expect(fused).toHaveLength(1);
    const [only] = fused;
    // Identity stays the VECTOR row's — the card is the richer representation.
    expect(only?.id).toBe("vector-uuid");
    expect(only?.semanticRank).toBe(1);
    expect(only?.registryRank).toBe(1);
    // Both arms contributed; neither replaced the other.
    expect(only?.rrfScore).toBeCloseTo(0.8 * 0.5 + 0.2 * 0.5, 10);
  });

  test("folds through the BM25 arm too, not just the semantic one", () => {
    const card = vectorRow({
      id: "vector-uuid",
      sourceType: "records",
      sourceId: "record-1",
    });
    const fused = fuse({
      bm25Rows: [card],
      registryRows: [registryRow("record-1")],
    });

    expect(fused).toHaveLength(1);
    expect(fused[0]?.id).toBe("vector-uuid");
    expect(fused[0]?.bm25Rank).toBe(1);
    expect(fused[0]?.registryRank).toBe(1);
  });

  test("a non-record vector row is never confused with a record", () => {
    // A document chunk whose `sourceId` happens to equal a record id must NOT
    // absorb the registry hit — the fold keys on sourceType too.
    const document = vectorRow({ id: "vector-uuid", sourceId: "record-1" });
    const fused = fuse({
      semanticRows: [document],
      registryRows: [registryRow("record-1")],
    });

    expect(fused).toHaveLength(2);
    expect(fused.map((c) => c.sourceType).sort()).toEqual([
      "documents",
      "records",
    ]);
  });
});

describe("fuseArms — the arm that carries above-ceiling records", () => {
  test("a record with no card becomes a candidate in its own right", () => {
    const fused = fuse({
      registryRows: [registryRow("record-1", "ACME Corp")],
    });

    expect(fused).toHaveLength(1);
    const [only] = fused;
    // Keyed by the RECORD id: stable across query variants, so `globalMerge`
    // accumulates a multi-variant hit instead of splitting it in two.
    expect(only?.id).toBe("record-1");
    expect(only?.sourceId).toBe("record-1");
    expect(only?.sourceType).toBe("records");
    expect(only?.semanticRank).toBeNull();
    expect(only?.bm25Rank).toBeNull();
    expect(only?.registryRank).toBe(1);
  });

  test("renders the type and the label so the reranker has something to score", () => {
    const fused = fuse({
      registryRows: [registryRow("record-1", "ACME Corp")],
    });
    expect(fused[0]?.content).toBe("Company: ACME Corp");
  });

  test("carries the metadata shape the citation layer expects", () => {
    const fused = fuse({
      registryRows: [registryRow("record-1", "ACME Corp")],
    });
    expect(fused[0]?.metadata).toEqual({
      object_type_id: "type-1",
      object_type_key: "company",
      label: "ACME Corp",
    });
  });

  test("a top registry hit outranks a mid-list semantic hit", () => {
    // The property that matters: RRF is a RECALL stage, so a record found only
    // by the registry must reach the reranker rather than be clipped by a wall
    // of document chunks. At weight 0.2, rank 1 scores 0.1 — ahead of the
    // semantic arm's 7th result (0.8/8 = 0.1) and everything below it.
    const semanticRows = Array.from({ length: 20 }, (_, i) =>
      vectorRow({ id: `doc-${String(i)}`, sourceId: `doc-${String(i)}` }),
    );
    const fused = fuse({
      semanticRows,
      registryRows: [registryRow("record-1")],
    });

    const position = fused.findIndex((c) => c.id === "record-1");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(10);
  });
});

describe("fuseArms — ordering and clipping", () => {
  test("output is sorted by fused score, descending", () => {
    const fused = fuse({
      semanticRows: [
        vectorRow({ id: "a", sourceId: "a" }),
        vectorRow({ id: "b", sourceId: "b" }),
        vectorRow({ id: "c", sourceId: "c" }),
      ],
    });
    const scores = fused.map((c) => c.rrfScore);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  test("clips to the requested output size", () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      vectorRow({ id: `r-${String(i)}`, sourceId: `r-${String(i)}` }),
    );
    expect(
      fuseArms({
        semanticRows: rows,
        bm25Rows: [],
        registryRows: [],
        weights: WEIGHTS,
        outputSize: 50,
      }),
    ).toHaveLength(50);
  });

  test("empty arms produce an empty result rather than throwing", () => {
    expect(fuse({})).toEqual([]);
  });
});

describe("fuseArms — the precision budget of the registry arm", () => {
  /**
   * The worst case for everything that is NOT a record: all three arms come
   * back full, with no overlap at all, so every slot the registry takes is a
   * document, skill or memory chunk that no longer reaches the reranker.
   *
   * This is the guard on the weight. Raising `REGISTRY_WEIGHT` is not a local
   * tuning decision — it directly buys record slots with skill and document
   * slots, and this test says how many.
   */
  const saturated = () => {
    const semanticRows = Array.from({ length: 150 }, (_, i) =>
      vectorRow({ id: `sem-${String(i)}`, sourceId: `sem-${String(i)}` }),
    );
    const bm25Rows = Array.from({ length: 150 }, (_, i) =>
      vectorRow({ id: `lex-${String(i)}`, sourceId: `lex-${String(i)}` }),
    );
    // 50, not 150: the arm is fetched only as deep as the output size, because
    // nothing can lift a registry-only candidate past the hits above it.
    const registryRows = Array.from({ length: 50 }, (_, i) =>
      registryRow(`rec-${String(i)}`),
    );
    return fuseArms({
      semanticRows,
      bm25Rows,
      registryRows,
      weights: WEIGHTS,
      outputSize: 50,
    });
  };

  test("records take at most a fifth of the pool when everything matches", () => {
    const records = saturated().filter((c) => c.sourceType === "records");
    expect(records.length).toBeLessThanOrEqual(10);
  });

  test("the semantic arm keeps the clear majority of the pool", () => {
    const fused = saturated();
    const semantic = fused.filter((c) => c.semanticRank !== null);
    expect(semantic.length).toBeGreaterThan(fused.length / 2);
  });

  test("no registry hit deeper than the output size could have survived", () => {
    // Justifies fetching only `outputSize` rows: rank 51 is outscored by the 50
    // registry hits above it, so it can never hold one of 50 slots even if the
    // other two arms return nothing at all.
    const deepest = saturated().reduce(
      (max, c) => Math.max(max, c.registryRank ?? 0),
      0,
    );
    expect(deepest).toBeLessThanOrEqual(50);
  });
});
