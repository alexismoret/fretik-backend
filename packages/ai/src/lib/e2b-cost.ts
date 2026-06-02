/**
 * Estimated E2B sandbox price per second (USD), env-overridable. E2B bills
 * per second of active sandbox runtime (rate depends on the vCPU/RAM tier);
 * sandboxes are paused at $0 between turns. We estimate per-exec cost as
 * `durationSeconds × this rate` — a lower bound (ignores resume/idle overhead
 * before pause). Public default is approximate; override with your tier rate.
 */
export const E2B_PRICE_PER_SECOND = (() => {
  const raw = Number(process.env.E2B_PRICE_PER_SECOND);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.0001;
})();
