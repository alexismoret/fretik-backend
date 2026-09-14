/**
 * How many tool calls ONE step may execute.
 *
 * `stopWhen` and `prepareStep` both run BETWEEN steps, so neither can see —
 * let alone stop — what happens inside one. Measured in production
 * (2026-09-09): a single step emitted roughly 1 450 tool calls, 729
 * `searchKnowledge` and 724 `askUserQuestion`, each with its own reranker and
 * cheap-model call behind it. Every between-steps brake in the product was
 * armed and none of them was ever reached, because the turn never got to a
 * second step.
 *
 * Twelve is well above any legitimate fan-out this product asks for — the
 * widest healthy step measured is a page builder writing five files in one
 * `pageWrite` plus a couple of reads — and far below the cost of a runaway.
 */
export class StepCallBudget {
  private step = -1;
  private used = 0;

  constructor(private readonly cap: number) {}

  /**
   * Open the budget for a step. Idempotent for the same step number, because
   * `prepareStep` may be wrapped more than once and a second reset mid-step
   * would hand a runaway a fresh allowance.
   */
  beginStep(step: number): void {
    if (step === this.step) return;
    this.step = step;
    this.used = 0;
  }

  /**
   * Claim one call. Synchronous by construction: parallel tool calls in one
   * step interleave only at `await` points, so read-then-write with no await
   * between them cannot lose a count.
   */
  tryAcquire(): boolean {
    this.used += 1;
    return this.used <= this.cap;
  }

  /** What the refusal message says, and what a test asserts on. */
  get limit(): number {
    return this.cap;
  }
}
