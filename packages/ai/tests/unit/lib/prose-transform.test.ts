/**
 * Prose-transform engine — the pure pieces of the `transform` tool's core:
 * chunk planning (paragraph packing + oversize hard-split) and result
 * assembly (order-preserving concatenation + failure/truncation notices).
 * The LLM calls are exercised in the tool test with a mocked engine.
 */

import { describe, expect, test } from "bun:test";
import {
  assembleTransformResult,
  type ChunkOutcome,
  planProseChunks,
  TRANSFORM_CHUNK_CHAR_BUDGET,
} from "../../../src/lib/prose-transform";

const ok = (output: string): ChunkOutcome => ({
  output,
  failed: false,
  truncated: false,
  usedFallback: false,
});

describe("planProseChunks", () => {
  test("packs whole paragraphs greedily under the budget", () => {
    const para = "x".repeat(300);
    const text = Array.from({ length: 10 }, () => para).join("\n\n");
    const chunks = planProseChunks(text, 1000);
    // 300+2 per paragraph → 3 paragraphs per 1000-char chunk.
    expect(chunks.length).toBe(4);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
    }
  });

  test("keeps paragraph order and loses no content", () => {
    const text = "alpha\n\nbeta\n\ngamma\n\ndelta";
    const chunks = planProseChunks(text, 12);
    expect(chunks.join(" ")).toContain("alpha");
    expect(chunks.join(" ")).toContain("delta");
    // Re-joining the chunks reproduces every block in order.
    expect(chunks.join("\n\n")).toBe(text);
  });

  test("hard-splits a single paragraph larger than the budget", () => {
    const giant = "y".repeat(2500);
    const chunks = planProseChunks(giant, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(1000);
    expect(chunks[2]?.length).toBe(500);
    expect(chunks.join("")).toBe(giant);
  });

  test("never emits a chunk over the budget", () => {
    const blocks = Array.from({ length: 40 }, (_, i) =>
      `Block ${i.toString()} `.repeat(50),
    ).join("\n\n");
    const chunks = planProseChunks(blocks, 2000);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });

  test("a document under budget stays one chunk", () => {
    const text = "short\n\ndocument";
    expect(planProseChunks(text, TRANSFORM_CHUNK_CHAR_BUDGET)).toEqual([text]);
  });

  test("empty text yields a single (empty) chunk, never throws", () => {
    expect(planProseChunks("", 1000)).toEqual([""]);
  });
});

describe("assembleTransformResult", () => {
  test("concatenates outputs in order with blank-line separators", () => {
    const result = assembleTransformResult([ok("un"), ok("deux"), ok("trois")]);
    expect(result.output).toBe("un\n\ndeux\n\ntrois");
    expect(result.chunks).toBe(3);
    expect(result.complete).toBe(true);
    expect(result.notices).toHaveLength(0);
  });

  test("a failed chunk keeps its original text and adds a notice", () => {
    const result = assembleTransformResult([
      ok("translated"),
      {
        output: "ORIGINAL",
        failed: true,
        truncated: false,
        usedFallback: true,
      },
    ]);
    expect(result.complete).toBe(false);
    expect(result.output).toContain("ORIGINAL");
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toContain("Section 2/2");
    expect(result.notices[0]).toContain("ORIGINAL text was kept");
  });

  test("a truncated chunk is flagged incomplete", () => {
    const result = assembleTransformResult([
      { output: "half", failed: false, truncated: true, usedFallback: false },
    ]);
    expect(result.complete).toBe(false);
    expect(result.notices[0]).toContain("output cap");
  });

  test("model id reflects whether the fallback was spent", () => {
    const primaryOnly = assembleTransformResult([ok("a")]);
    expect(primaryOnly.model).not.toContain("+");
    const withFallback = assembleTransformResult([
      { output: "a", failed: false, truncated: false, usedFallback: true },
    ]);
    expect(withFallback.model).toContain("+");
  });
});
