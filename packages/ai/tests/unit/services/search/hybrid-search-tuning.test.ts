/**
 * The three things in `hybrid-search.ts` that decide behaviour without any
 * database being involved, and that a live eval would not tell you about.
 *
 * The tuning statement is the load-bearing one: `hnsw.iterative_scan` is what
 * keeps the semantic arm returning the 150 rows it asked for as the corpus
 * grows (measured 2026-09-10 — with it off, pgvector returns 87 of 150 at
 * ef=100 and 32 of 150 at its own default, silently). If that setting ever
 * stops reaching the transaction the suite still passes at today's volume and
 * the arm quietly loses its tail in production, which is the exact failure this
 * phase exists to prevent.
 */

import { describe, expect, test } from "bun:test";
import {
  armLabel,
  HYBRID_CONSTANTS,
  semanticTuningSql,
  shouldProbeForFamine,
} from "../../../../src/services/search/hybrid-search";

/** Render a drizzle SQL fragment to the text + params actually sent. */
const rendered = (mode: "hnsw" | "exact"): string => {
  const chunks = semanticTuningSql(mode).queryChunks;
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      if (c instanceof Uint8Array) return new TextDecoder().decode(c);
      if (typeof c === "object" && c !== null && "value" in c)
        return String((c as { value: unknown }).value);
      return "";
    })
    .join("");
};

describe("semantic tuning statement", () => {
  test("hnsw mode sends BOTH settings, in one statement", () => {
    const sql = rendered("hnsw");
    expect(sql).toContain("hnsw.ef_search");
    expect(sql).toContain("hnsw.iterative_scan");
    // One statement, not two: `set_config` exists here precisely so two
    // settings cost one round trip to a database that is not on localhost.
    expect(sql.split(";").filter((s) => s.trim().length > 0)).toHaveLength(1);
  });

  test("hnsw mode sets both settings LOCAL to the transaction", () => {
    // `is_local => false` would leak the tuning onto the pooled connection and
    // silently apply it to every later query that borrows it.
    const sql = rendered("hnsw");
    expect(sql).not.toContain("false");
    expect(sql.match(/true/g) ?? []).toHaveLength(2);
  });

  test("hnsw mode carries the values this file documents", () => {
    const sql = rendered("hnsw");
    expect(sql).toContain(String(HYBRID_CONSTANTS.HNSW_EF_SEARCH));
    expect(sql).toContain(HYBRID_CONSTANTS.HNSW_ITERATIVE_SCAN);
  });

  test("ef_search is at least the pool size the arm asks for", () => {
    // Below `PER_SEARCH_LIMIT` the index cannot hold enough candidates to fill
    // one pass, and the arm starts depending entirely on the iterative scan to
    // make its row count back. Measured: ef=100 with iterative scan off returns
    // 87 of 150.
    expect(HYBRID_CONSTANTS.HNSW_EF_SEARCH).toBeGreaterThanOrEqual(
      HYBRID_CONSTANTS.PER_SEARCH_LIMIT,
    );
  });

  test("exact mode forbids the index scan and tunes nothing", () => {
    const sql = rendered("exact");
    expect(sql).toContain("enable_indexscan");
    expect(sql).toContain("off");
    expect(sql).not.toContain("hnsw.");
  });

  test("the default mode is hnsw", () => {
    expect(HYBRID_CONSTANTS.SEMANTIC_SCAN_MODE).toBe("hnsw");
    expect(rendered("hnsw")).toBe(
      rendered(HYBRID_CONSTANTS.SEMANTIC_SCAN_MODE),
    );
  });
});

describe("arm label", () => {
  test("names each of the three arms recall actually fires", () => {
    expect(armLabel({ sourceTypes: ["memories", "episodes", "records"] })).toBe(
      "memories+episodes+records",
    );
    expect(armLabel({ sourceTypes: ["documents"] })).toBe("documents");
    expect(armLabel({ sourceTypes: ["workflows", "pages"] })).toBe(
      "workflows+pages",
    );
  });

  test("an unfiltered search is labelled, not blank", () => {
    // The `[hybrid]` line is how a timing is attributed to a population; a
    // blank label would pool the unfiltered case in with whatever came before.
    expect(armLabel(undefined)).toBe("all");
    expect(armLabel({})).toBe("all");
    expect(armLabel({ sourceTypes: [] })).toBe("all");
  });
});

describe("famine probe gate", () => {
  test("a full arm is never probed", () => {
    expect(
      shouldProbeForFamine(HYBRID_CONSTANTS.PER_SEARCH_LIMIT, "hnsw"),
    ).toBe(false);
  });

  test("a short arm is probed under hnsw", () => {
    expect(
      shouldProbeForFamine(HYBRID_CONSTANTS.PER_SEARCH_LIMIT - 1, "hnsw"),
    ).toBe(true);
    expect(shouldProbeForFamine(0, "hnsw")).toBe(true);
  });

  test("exact mode is never probed", () => {
    // An exact scan that returns short returned short because that is all there
    // is. Probing it would spend a query per search to learn nothing.
    expect(shouldProbeForFamine(0, "exact")).toBe(false);
  });
});
