/**
 * Numeric tunables read from the environment.
 *
 * Every long-running surface has knobs an operator may need to move without a
 * deploy — sweep batch sizes, debounce windows, concurrency, an upstream's rate
 * budget. They all want the same reading: a positive integer, or the code's
 * default when the variable is absent, empty, malformed, zero or negative.
 * Silently falling back beats throwing at import: a typo in one env var must
 * not stop a whole worker process from booting.
 *
 * It lives here rather than in `@fretik/jobs` because the governor
 * (`services/external-apps/exec/governor`) reads the same knobs from the API
 * and the AI service, and a second copy of this reading is how two processes
 * end up disagreeing about what `0` means.
 */
export const intFromEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/**
 * Same, but `0` is an answer rather than a typo — it is how an operator turns
 * a budget OFF. Only a negative or malformed value falls back.
 */
export const intFromEnvAllowingZero = (
  name: string,
  fallback: number,
): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
};

/**
 * Same reading for a switch: only an explicit `true` (any casing) turns one on.
 * Anything else — absent, empty, `1`, a typo — is the default, because a knob
 * that guards destructive work must never be enabled by accident.
 */
export const boolFromEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "true";
};
