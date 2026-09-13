/**
 * Synthetic distractor geometry for the recall scale test (`--scale N`).
 *
 * Its own module, with no database import, so the one thing here that can be
 * silently wrong is unit-testable: whether the distractors land ON the
 * embedding manifold. Uniform random vectors in 2560 dims are all very nearly
 * orthogonal to everything, so an index full of them is trivially separable —
 * a scale test built from them reports a healthy index at any N and measures
 * nothing. Perturbing REAL vectors is what makes the corpus adversarial, and
 * `SCALE_SIGMA` is the knob that decides whether it still is.
 */

/**
 * Per-dimension noise standard deviation, applied before renormalisation.
 *
 * 0.02, and it is a measurement (2026-09-10, against real `ai_vectors` rows of
 * the EVAL team — stored embeddings are unit-norm, so the whole effect is the
 * ratio of noise norm σ·√2560 to 1):
 *
 *   σ=0.2 → cos 0.09 · σ=0.05 → cos 0.37 · **σ=0.02 → cos 0.70** ·
 *   σ=0.01 → cos 0.89 · σ=0.005 → cos 0.97 · σ=0.002 → cos 0.99
 *
 * and the number that decides between them is the corpus's own spread: four
 * real documents of that team sit at cosine 0.42-0.88 from each other. σ=0.02
 * lands a distractor INSIDE that band, so it is as similar to its base as the
 * team's own content is to itself — indistinguishable from a real neighbour,
 * which is the only kind of row that makes an ANN index work for its answer.
 *
 * Both directions are failure modes, and neither announces itself:
 *   - too LARGE (σ≥0.05, cos<0.4) → near-orthogonal noise. In 2560 dims that is
 *     trivially separable, and `--scale 50000` reports a healthy semantic arm
 *     however broken it is.
 *   - too SMALL (σ≤0.005, cos>0.97) → near-duplicates of real rows. They
 *     outrank the fixtures and the scale run fails its ASSERTIONS, which reads
 *     as a recall regression instead of a corpus that was seeded wrong.
 */
export const SCALE_SIGMA = 0.02;

/** One standard normal (Box–Muller). */
export const gaussian = (): number => {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/**
 * Trim a vector to `dp` decimal places.
 *
 * Purely a wire-size measure, and provably lossless for this column: a
 * full-precision row serialises to 54.7 KB of INSERT text (2.7 GB for 50 000
 * rows), while `halfvec` is fp16, whose own narrowing already introduces 2.0e-5
 * of absolute error. At 5 dp the rounding error is 5.0e-6 — finer than what
 * Postgres stores either way, for roughly half the bytes.
 */
export const round = (v: number[], dp: number): number[] => {
  const f = 10 ** dp;
  return v.map((x) => Math.round(x * f) / f);
};

/**
 * `base` + N(0, sigma) per dimension, renormalised to unit L2.
 *
 * Unit norm because the index is `halfvec_cosine_ops`: leaving the magnitude
 * free would let a distractor differ from a real row on a dimension the
 * distance function ignores, which is a difference that is not there.
 */
export const perturb = (base: number[], sigma: number): number[] => {
  const out = new Array<number>(base.length);
  let norm = 0;
  for (let i = 0; i < base.length; i++) {
    const value = (base[i] ?? 0) + gaussian() * sigma;
    out[i] = value;
    norm += value * value;
  }
  if (norm === 0) return base;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) * inv;
  return out;
};
