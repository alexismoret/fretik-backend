/**
 * Parse an integer environment variable behind a default and an inclusive
 * `[min, max]` range guard. Unset / empty → `fallback`; anything malformed or
 * out of range throws at boot so a misconfiguration fails loudly instead of
 * silently degrading a live agent. Single home for the chatbot/workflow step
 * and token knobs — the callers keep their rationale docblocks and just supply
 * the bounds.
 */
export const parseIntEnv = (
  name: string,
  { fallback, min, max }: { fallback: number; min: number; max: number },
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid ${name}: "${raw}" — expected an integer in [${min}, ${max}].`,
    );
  }
  return parsed;
};
