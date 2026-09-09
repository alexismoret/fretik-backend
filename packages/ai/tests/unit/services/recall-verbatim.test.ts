import { describe, expect, test } from "bun:test";
import type {
  RecallGathered,
  RecallSearchHit,
} from "../../../src/services/recall/candidates";
import type { GraphNeighborhood } from "../../../src/services/recall/graph";
import { buildVerbatimBlock } from "../../../src/services/recall/verbatim";

/**
 * `buildVerbatimBlock` is the deterministic selector — the judge-free path
 * behind `RECALL_MODE=verbatim`. It is a PURE function over an already-gathered
 * candidate set, which is precisely why it can be tested here: every decision
 * the judge made with a model, this makes with score floors, per-source caps
 * and a corroboration rule, so every one of them is assertable.
 *
 * What is NOT settled here: whether the block it produces answers a user's
 * question as well as the judge's. That is what `bun run evals:recall` scores
 * (run it with `RECALL_MODE=verbatim` to compare against the default). These
 * tests pin the mechanics the eval cannot see — that a floor drops what it
 * should, that an uncorroborated homonym never reaches the prompt, that the
 * stamping set matches what was actually rendered.
 */

const hit = (
  over: Partial<RecallSearchHit> &
    Pick<RecallSearchHit, "sourceType" | "sourceId">,
): RecallSearchHit => ({
  content: `content of ${over.sourceId}`,
  metadata: {},
  rerankScore: 0.9,
  ...over,
});

const gathered = (over: Partial<RecallGathered> = {}): RecallGathered => ({
  anchors: [],
  knowledgeResults: [],
  documentResults: [],
  graph: null,
  capabilityResults: [],
  ...over,
});

const graph = (over: Partial<GraphNeighborhood> = {}): GraphNeighborhood => ({
  rendered: "",
  perAnchor: [],
  episodes: [],
  ...over,
});

describe("buildVerbatimBlock — selection", () => {
  test("an empty gather produces no block at all", () => {
    const result = buildVerbatimBlock(gathered());
    expect(result.block).toBeNull();
    expect(result.recalledEpisodeIds).toEqual([]);
  });

  test("renders each source under its own section, with real ids as markers", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({
            sourceType: "memories",
            sourceId: "m-1",
            metadata: { path: "team/processes/recap.md" },
          }),
          hit({ sourceType: "records", sourceId: "rec-1" }),
        ],
      }),
    );
    expect(result.block).toContain("FACTS");
    expect(result.block).toContain("(memory:team/processes/recap.md)");
    expect(result.block).toContain("RECORDS");
    expect(result.block).toContain("(record:rec-1)");
  });

  test("drops candidates below the relative floor of the best score", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "strong", rerankScore: 0.9 }),
          // 0.05 is well under 35% of 0.9.
          hit({ sourceType: "records", sourceId: "weak", rerankScore: 0.05 }),
        ],
      }),
    );
    expect(result.block).toContain("(record:strong)");
    expect(result.block).not.toContain("(record:weak)");
  });

  test("keeps everything when rerank degraded (no scores to compare)", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "a", rerankScore: null }),
          hit({ sourceType: "records", sourceId: "b", rerankScore: null }),
        ],
      }),
    );
    // A retrieval outage must not silently empty the memory block.
    expect(result.block).toContain("(record:a)");
    expect(result.block).toContain("(record:b)");
  });

  test("caps each source independently", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: Array.from({ length: 8 }, (_, i) =>
          hit({ sourceType: "records", sourceId: `rec-${i.toString()}` }),
        ),
      }),
    );
    const rendered = result.block ?? "";
    const count = [...rendered.matchAll(/\(record:/g)].length;
    // Two per source, not three: the block shares one 2 000-char ceiling with
    // the judge, and nine candidates inside it would carry less per candidate
    // than the judge's own 200-char bullets.
    expect(count).toBe(2);
  });

  test("withholds the whole block when the best hit is weak", () => {
    // The abstention gate, distinct from the per-candidate floors: those are
    // relative, so on a gather where nothing is relevant they rank noise
    // against noise and inject the winner.
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "episodes", sourceId: "ep-a", rerankScore: 0.08 }),
          hit({ sourceType: "records", sourceId: "rec-a", rerankScore: 0.05 }),
        ],
      }),
    );
    expect(result.block).toBeNull();
    expect(result.ambiguity.bestScore).toBeCloseTo(0.08);
  });

  test("a block never exceeds the budget it shares with the judge", () => {
    const long = "Lorem ipsum dolor sit amet. ".repeat(200);
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "memories", sourceId: "m-1", content: long }),
          hit({ sourceType: "memories", sourceId: "m-2", content: long }),
          hit({ sourceType: "episodes", sourceId: "e-1", content: long }),
          hit({ sourceType: "episodes", sourceId: "e-2", content: long }),
          hit({ sourceType: "records", sourceId: "r-1", content: long }),
          hit({ sourceType: "records", sourceId: "r-2", content: long }),
        ],
      }),
    );
    expect((result.block ?? "").length).toBeLessThanOrEqual(2000);
  });

  test("a document that merely shares vocabulary stays out — JIT handles it", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "rec-1", rerankScore: 0.9 }),
        ],
        documentResults: [
          hit({ sourceType: "documents", sourceId: "doc-1", rerankScore: 0.4 }),
        ],
      }),
    );
    expect(result.block).toContain("(record:rec-1)");
    expect(result.block).not.toContain("(document:doc-1)");
  });

  test("a document that tops the ranking IS the answer, and rides", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "rec-1", rerankScore: 0.4 }),
        ],
        documentResults: [
          hit({
            sourceType: "documents",
            sourceId: "doc-1",
            rerankScore: 0.95,
          }),
        ],
      }),
    );
    expect(result.block).toContain("(document:doc-1)");
  });
});

describe("buildVerbatimBlock — the anchor corroboration gate", () => {
  test("a NAME-exact anchor stands on its own", () => {
    const result = buildVerbatimBlock(
      gathered({
        graph: graph({
          perAnchor: [
            {
              recordId: "nordwind",
              matchType: "exact",
              lines: ["- Nordwind GmbH (record:nordwind)"],
            },
          ],
        }),
      }),
    );
    expect(result.block).toContain("(record:nordwind)");
    expect(result.ambiguity.uncorroboratedAnchors).toBe(0);
  });

  test("a lexical-only anchor with no semantic corroboration is dropped", () => {
    // The homonym case: `horizon` matched a project record's field text, but
    // the semantic arm never surfaced that record — the message is about
    // investment horizons.
    const result = buildVerbatimBlock(
      gathered({
        graph: graph({
          perAnchor: [
            {
              recordId: "projet-horizon",
              matchType: "fts",
              lines: ["- Projet Horizon (record:projet-horizon)"],
            },
          ],
        }),
      }),
    );
    expect(result.block).toBeNull();
    expect(result.ambiguity.uncorroboratedAnchors).toBe(1);
  });

  test("the same lexical anchor survives once the semantic arm agrees", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "projet-horizon" }),
        ],
        graph: graph({
          perAnchor: [
            {
              recordId: "projet-horizon",
              matchType: "fts",
              lines: ["- Projet Horizon (record:projet-horizon)"],
            },
          ],
        }),
      }),
    );
    expect(result.block).toContain("GRAPH");
    expect(result.ambiguity.uncorroboratedAnchors).toBe(0);
  });
});

describe("buildVerbatimBlock — episode stamping", () => {
  test("stamps only the episodes that actually reached the block", () => {
    const result = buildVerbatimBlock(
      gathered({
        graph: graph({
          episodes: [
            {
              id: "ep-1",
              title: "Contrat Nordwind",
              summary: "Cadence de livraison décidée à 2 semaines.",
              occurredTo: new Date("2026-06-30T00:00:00Z"),
              anchorLabels: ["Nordwind GmbH"],
            },
          ],
        }),
      }),
    );
    expect(result.recalledEpisodeIds).toEqual(["ep-1"]);
    expect(result.block).toContain("As of 2026-06-30");
    expect(result.block).toContain("Linked records: Nordwind GmbH");
  });

  test("a graph episode is not duplicated by the semantic arm", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [hit({ sourceType: "episodes", sourceId: "ep-1" })],
        graph: graph({
          episodes: [
            {
              id: "ep-1",
              title: "Contrat Nordwind",
              summary: "Cadence décidée.",
              occurredTo: null,
              anchorLabels: [],
            },
          ],
        }),
      }),
    );
    const rendered = result.block ?? "";
    expect([...rendered.matchAll(/\(episode:ep-1\)/g)].length).toBe(1);
    expect(result.recalledEpisodeIds).toEqual(["ep-1"]);
  });
});

describe("buildVerbatimBlock — ambiguity signals", () => {
  test("flags a near-tie between two candidates of the same source", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "episodes", sourceId: "ep-a", rerankScore: 0.62 }),
          hit({ sourceType: "episodes", sourceId: "ep-b", rerankScore: 0.6 }),
        ],
      }),
    );
    expect(result.ambiguity.nearTies).toBe(1);
  });

  test("a clear winner is not a near-tie", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "episodes", sourceId: "ep-a", rerankScore: 0.9 }),
          hit({ sourceType: "episodes", sourceId: "ep-b", rerankScore: 0.4 }),
        ],
      }),
    );
    expect(result.ambiguity.nearTies).toBe(0);
  });

  test("flags the grey zone where retrieval is neither confident nor silent", () => {
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "records", sourceId: "rec-1", rerankScore: 0.3 }),
        ],
      }),
    );
    expect(result.ambiguity.greyZone).toBe(true);
  });
});

describe("buildVerbatimBlock — graph episodes yield a slot", () => {
  const graphEpisode = (id: string) => ({
    id,
    title: `graph ${id}`,
    summary: "older activity on the same record",
    occurredTo: null,
    anchorLabels: ["Calliope Verre"],
  });

  test("the semantic arm keeps a slot when the graph could fill them all", () => {
    // `chain-decision-survives`: a record with a long history buries the one
    // episode that answers the question. The graph ranks on recency + recall
    // count, which knows nothing about the message.
    const result = buildVerbatimBlock(
      gathered({
        knowledgeResults: [
          hit({ sourceType: "episodes", sourceId: "the-decision" }),
        ],
        // Enough graph episodes to fill every slot on their own.
        graph: graph({
          episodes: [
            graphEpisode("old-a"),
            graphEpisode("old-b"),
            graphEpisode("old-c"),
          ],
        }),
      }),
    );
    // The invariant is the reserved slot, not the count: however long a
    // record's history is, what the message is actually about still lands.
    expect(result.block).toContain("(episode:the-decision)");
    expect(result.block).toContain("(episode:old-a)");
    expect(result.block).not.toContain("(episode:old-c)");
  });

  test("with nothing semantic to say, the graph still takes every slot", () => {
    const result = buildVerbatimBlock(
      gathered({
        graph: graph({
          episodes: [graphEpisode("old-a"), graphEpisode("old-b")],
        }),
      }),
    );
    expect(result.block).toContain("(episode:old-a)");
    expect(result.block).toContain("(episode:old-b)");
  });
});
