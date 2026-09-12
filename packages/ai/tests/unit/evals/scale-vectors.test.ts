/**
 * The one thing about `--scale` that can be silently wrong.
 *
 * The distractors exist to make an ANN index work: they have to be NEAR
 * neighbours of real content. If the noise were too large the corpus would be
 * uniform random vectors, which in 2560 dims are all mutually near-orthogonal —
 * an index full of them separates trivially, and `--scale 50000` would report
 * a healthy semantic arm however broken it was. Nothing else in the harness can
 * catch that: a scale run with off-manifold rows PASSES.
 */

import { describe, expect, test } from "bun:test";
import {
  gaussian,
  perturb,
  round,
  SCALE_SIGMA,
} from "../../../evals/recall/scale-vectors";

const DIMS = 2560;

const unitVector = (dims: number): number[] => {
  const raw = Array.from({ length: dims }, () => gaussian());
  const norm = Math.sqrt(raw.reduce((a, v) => a + v * v, 0));
  return raw.map((v) => v / norm);
};

const dot = (a: number[], b: number[]): number =>
  a.reduce((acc, v, i) => acc + v * (b[i] ?? 0), 0);

const l2 = (v: number[]): number => Math.sqrt(dot(v, v));

describe("scale distractor geometry", () => {
  test("output is unit-norm, so cosine distance sees only direction", () => {
    const base = unitVector(DIMS);
    const out = perturb(base, SCALE_SIGMA);
    expect(l2(out)).toBeCloseTo(1, 6);
  });

  test("output keeps the base's DIMENSION and is renormalised even from a non-unit base", () => {
    const base = unitVector(DIMS).map((v) => v * 7);
    const out = perturb(base, SCALE_SIGMA);
    expect(out).toHaveLength(DIMS);
    expect(l2(out)).toBeCloseTo(1, 6);
  });

  test("at SCALE_SIGMA a distractor lands inside the corpus's own similarity spread", () => {
    // The load-bearing assertion, and the band comes from the corpus, not from
    // taste: four real documents of the EVAL team sit at cosine 0.42-0.88 from
    // each other, and sigma=0.02 puts a distractor at ~0.70 from its base
    // (measured 2026-09-10). A distractor as similar to real content as real
    // content is to itself is one an index cannot shortcut.
    const base = unitVector(DIMS);
    for (let i = 0; i < 5; i++) {
      const cos = dot(base, perturb(base, SCALE_SIGMA));
      expect(cos).toBeGreaterThan(0.4);
      expect(cos).toBeLessThan(0.9);
    }
  });

  test("too LARGE a sigma degenerates into near-orthogonal noise", () => {
    // The first of the two silent failure modes, and it proves the band above
    // can actually fail. Noise this size is trivially separable in 2560 dims, so
    // a scale run built on it reports a healthy index however broken it is.
    const base = unitVector(DIMS);
    expect(Math.abs(dot(base, perturb(base, 0.2)))).toBeLessThan(0.4);
  });

  test("too SMALL a sigma degenerates into near-duplicates", () => {
    // The other one. These outrank the fixtures, so the scale run fails its
    // ASSERTIONS and reads as a recall regression rather than a bad corpus.
    const base = unitVector(DIMS);
    expect(dot(base, perturb(base, 0.002))).toBeGreaterThan(0.97);
  });

  test("distinct calls produce distinct vectors", () => {
    const base = unitVector(DIMS);
    const a = perturb(base, SCALE_SIGMA);
    const b = perturb(base, SCALE_SIGMA);
    expect(a).not.toEqual(b);
  });

  test("a zero base is returned unchanged rather than dividing by zero", () => {
    const zero = new Array<number>(8).fill(0);
    expect(perturb(zero, 0)).toEqual(zero);
  });

  test("rounding to SCALE_DECIMALS stays finer than the fp16 column itself", () => {
    // The claim that makes the wire saving free. `halfvec` is fp16, whose own
    // narrowing costs ~2e-5 of absolute error on unit-norm components; rounding
    // to 5 dp costs at most 5e-6. If someone lowers the constant to 3 dp to save
    // more bytes, this goes red — at 5e-4 the rounding would be coarser than the
    // storage and the distractors would stop being the vectors we computed.
    const FP16_ERROR = 2e-5;
    const base = unitVector(DIMS);
    const trimmed = round(base, 5);
    const maxErr = Math.max(
      ...base.map((v, i) => Math.abs(v - (trimmed[i] ?? 0))),
    );
    expect(maxErr).toBeLessThan(FP16_ERROR);
  });

  test("rounding does not move a vector off its own direction", () => {
    const base = unitVector(DIMS);
    expect(dot(base, round(base, 5)) / l2(round(base, 5))).toBeGreaterThan(
      0.9999,
    );
  });
});
