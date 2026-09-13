/**
 * When to spend an LLM call, decided without touching anything.
 *
 * Three outcomes rather than two, because "the context moved" and "somebody is
 * waiting" are different questions. A stale batch is still a good batch: it is
 * served immediately and replaced behind the reader's back, so the only person
 * who ever waits is the one who has never seen a suggestion at all.
 *
 * The numbers bound the cost: an untouched workspace regenerates once a day
 * (the pack's hash carries the date), and the busiest one regenerates at most
 * once an hour per member.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type FreshnessDecision = "generate" | "serve" | "serve-and-refresh";

export const decideFreshness = (
  batch: { createdAt: Date; inputHash: string } | null,
  inputHash: string,
  now: Date,
): FreshnessDecision => {
  // Nothing to show. The only case where anybody waits.
  if (!batch) return "generate";

  const age = now.getTime() - batch.createdAt.getTime();
  if (age >= MAX_AGE_MS) return "serve-and-refresh";
  // A changed context earns a rewrite, but not more often than hourly — a
  // single upload should not re-price the screen.
  if (batch.inputHash !== inputHash && age >= STALE_AFTER_MS) {
    return "serve-and-refresh";
  }
  return "serve";
};
