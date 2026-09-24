import { systemPrincipal } from "./principal";

/**
 * Every caller that acts for NOBODY IN PARTICULAR, by name.
 *
 * A service never assumes trust from a missing argument any more: it takes a
 * principal, and code that is not acting for a person passes one of these.
 * Keeping them in one list makes the trusted entry points reviewable at a
 * glance — adding one is a decision someone reads, not a parameter someone
 * forgot.
 */
export const SYSTEM = {
  /**
   * The workflow engine: triggers (cron, events, forms), the turn executor,
   * run finalization and the guards that stop a workflow on their own (the
   * circuit breaker, the runaway guard, an owner's departure).
   */
  workflowEngine: systemPrincipal(
    "workflow engine: triggers, turns, finalization and automatic guards",
  ),
  /** A page served on its public link: the token is the authorisation. */
  publicPage: systemPrincipal("published page, authorised by its public token"),
  /** Background upkeep that re-derives state (vectors, pins, digests). */
  maintenance: systemPrincipal(
    "background upkeep: re-indexing and reconciliation",
  ),
  /**
   * A script an operator runs from a shell (evals, backfills). Whoever runs it
   * already holds the database credentials; the engine adds nothing there.
   */
  operatorScript: systemPrincipal(
    "operator script run from a shell with database access",
  ),
} as const;
