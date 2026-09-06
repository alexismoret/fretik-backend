import { describe, expect, test } from "bun:test";
import type { PageWriteRecord } from "../../../../src/services/page-project/store";
import {
  buildWriteReport,
  latestPerPage,
  type PageVersionSample,
} from "../../../../src/services/page-project/write-report";

/**
 * The two counting mistakes this report used to make, pinned.
 *
 * Both read as measurements rather than as bugs, and both were argued from:
 * "3% of writes were edits, 94 writes per page" was reported in September 2026
 * from a window where neither number meant what it said.
 */

const write = (
  path: string,
  fields: Partial<PageWriteRecord> = {},
): PageWriteRecord => ({
  mode: "write",
  path,
  linesChanged: 40,
  linesTotal: 40,
  charsEmitted: 1_200,
  ratio: 1,
  ...fields,
});

const version = (
  pageId: string,
  minutesAgo: number,
  writes: PageWriteRecord[],
  usage?: PageVersionSample["usage"],
): PageVersionSample => ({
  pageId,
  createdAt: new Date(Date.now() - minutesAgo * 60_000),
  writes,
  ...(usage !== undefined ? { usage } : {}),
});

describe("one version per page", () => {
  test("a write that survived three builds is counted ONCE", () => {
    // `state.writes` is cumulative and every green build stamps the whole
    // array onto its version, so flattening the versions counts the first
    // write once per build that followed it — weighted toward the early
    // whole-file layout and against the late edits, which is the direction
    // that made edits look rare.
    const layout = [write("Page.vue"), write("components/Kpi.vue")];
    const report = buildWriteReport([
      version("p1", 30, layout),
      version("p1", 20, [...layout, write("Page.vue", { mode: "edit" })]),
      version("p1", 10, [
        ...layout,
        write("Page.vue", { mode: "edit" }),
        write("components/Kpi.vue", { mode: "edit" }),
      ]),
    ]);

    expect(report.files).toBe(4);
    expect(report.pages).toBe(1);
    // Two writes, two edits — half. Flattening every version would say 9
    // records, 3 of them edits: 33%.
    expect(report.editShare).toBeCloseTo(0.5, 10);
  });

  test("latestPerPage keeps the newest row of each page", () => {
    const kept = latestPerPage([
      version("p1", 30, [write("a.vue")]),
      version("p1", 5, [write("a.vue"), write("b.vue")]),
      version("p2", 12, [write("c.vue")]),
    ]);

    expect(kept).toHaveLength(2);
    expect(kept.find((s) => s.pageId === "p1")?.writes).toHaveLength(2);
  });
});

describe("records are grouped back into calls", () => {
  test("a twelve-file layout is ONE write call, not twelve", () => {
    // `measurePageWrite` runs inside `pageWrite`'s per-file loop. Counting
    // records makes a batch look like a burst — and a burst is what the prose
    // tells the builder to avoid, so the metric contradicted the rule it was
    // meant to check.
    const files = Array.from({ length: 12 }, (_, i) =>
      write(`components/C${i.toString()}.vue`, { callId: "call_1" }),
    );
    const report = buildWriteReport([
      version("p1", 5, [
        ...files,
        write("Page.vue", { mode: "edit", callId: "call_2" }),
      ]),
    ]);

    expect(report.calls).toBe(2);
    expect(report.files).toBe(13);
    expect(report.editShare).toBeCloseTo(0.5, 10);
    expect(report.byMode.find((m) => m.mode === "write")?.calls).toBe(1);
    expect(report.byMode.find((m) => m.mode === "write")?.files).toBe(12);
    // Chars are summed per CALL, because that is what one emission cost.
    expect(
      report.byMode.find((m) => m.mode === "write")?.medianCharsPerCall,
    ).toBe(12 * 1_200);
  });

  test("two separate calls stay two calls", () => {
    const report = buildWriteReport([
      version("p1", 5, [
        write("a.vue", { callId: "call_1" }),
        write("b.vue", { callId: "call_2" }),
      ]),
    ]);

    expect(report.calls).toBe(2);
  });

  test("records predating call ids count as one call each, and say so", () => {
    const report = buildWriteReport([
      version("p1", 5, [write("a.vue"), write("b.vue")]),
    ]);

    expect(report.calls).toBe(2);
    expect(report.recordsWithoutCallId).toBe(2);
  });
});

describe("cost", () => {
  test("the median comes from the pages that carry a usage figure", () => {
    const report = buildWriteReport([
      version("p1", 5, [write("a.vue")], {
        steps: 30,
        costedSteps: 30,
        costUsd: 0.75,
      }),
      version("p2", 5, [write("b.vue")], {
        steps: 18,
        costedSteps: 18,
        costUsd: 0.41,
      }),
      version("p3", 5, [write("c.vue")]),
    ]);

    expect(report.cost?.pages).toBe(2);
    expect(report.cost?.medianUsd).toBe(0.75);
    expect(report.cost?.medianSteps).toBe(30);
  });

  test("no priced page means no cost block, never a zero", () => {
    const report = buildWriteReport([version("p1", 5, [write("a.vue")])]);
    expect(report.cost).toBeUndefined();
  });
});
