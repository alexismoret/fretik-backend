/**
 * Numeric tunables read from the environment.
 *
 * Every worker in this package has knobs an operator may need to move without a
 * deploy — sweep batch sizes, debounce windows, concurrency. They all want the
 * same reading: a positive integer, or the code's default when the variable is
 * absent, empty, malformed, zero or negative. Silently falling back beats
 * throwing at import: a typo in one env var must not stop the whole worker
 * process from booting.
 */
export const intFromEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};
