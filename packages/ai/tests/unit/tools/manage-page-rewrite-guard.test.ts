import "@hono/zod-openapi";
import { describe, expect, test } from "bun:test";
import { isDestructiveRewrite } from "../../../src/tools/manage-page";

/**
 * What the rewrite guard refuses — and, as importantly, what it lets through.
 *
 * The first cut refused EVERY whole-file `definition.code` without
 * `rewrite: true`. Measured on `pages-final-v2` (2026-08-23), that shape was
 * pure waste: the refusal lands after the model has already generated the
 * full definition (~16k output tokens), and it re-emits the identical bytes
 * with the flag added — every page-scale write billed twice, zero writes made
 * smaller. The guard's real job is the destructive case (a "repair" that kept
 * 370 of 1272 lines), so only a dramatic shrink is refused now.
 */
describe("isDestructiveRewrite", () => {
  const stored = "x".repeat(1000);

  test("refuses a replacement far smaller than the stored source", () => {
    expect(isDestructiveRewrite(stored, "x".repeat(290))).toBe(true);
  });

  test("accepts growth — the draft-fill and add-a-section shapes", () => {
    expect(isDestructiveRewrite(stored, "x".repeat(2000))).toBe(false);
  });

  test("accepts mild shrink — dead code removed is not destruction", () => {
    expect(isDestructiveRewrite(stored, "x".repeat(800))).toBe(false);
  });

  test("the boundary is 70% of the stored length", () => {
    expect(isDestructiveRewrite(stored, "x".repeat(699))).toBe(true);
    expect(isDestructiveRewrite(stored, "x".repeat(700))).toBe(false);
  });

  test("an empty stored source can never be destroyed", () => {
    expect(isDestructiveRewrite("", "x".repeat(10))).toBe(false);
    expect(isDestructiveRewrite("   \n  ", "x".repeat(10))).toBe(false);
  });
});
