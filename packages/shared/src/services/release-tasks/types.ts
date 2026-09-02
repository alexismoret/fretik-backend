/**
 * What a release task is, and — as much — what it is not.
 *
 * A release task runs ONCE per deployed version, automatically, on a service
 * that boots with the credentials it needs. That makes it the right home for
 * exactly one kind of job: something that must be true of every deployment,
 * that nobody should have to remember, and whose re-run is harmless.
 *
 * THREE THINGS DISQUALIFY A SCRIPT, and each has ruled one out already:
 *
 *  1. **It is not needed on every deploy.** `reseed-system-ontology` matters
 *     when the seeded set changes, which is a handful of times a year. A job
 *     that is usually a no-op still writes, still takes time, and still has to
 *     be right — for nothing.
 *  2. **It could damage data that is already correct.** `sync-collection-tables`
 *     performs DDL across every team including column DROPS. Its own header
 *     calls it a backfill/repair primitive: new teams get their tables at
 *     creation time. Automatic destructive DDL is how a good database becomes
 *     a bad one at 3 a.m.
 *  3. **It writes fixtures into the target database.** `check-collections-rls`
 *     creates a real organization, two teams and records to verify isolation,
 *     then deletes them. Correct for a verification you drive; unacceptable as
 *     a thing that happens to production because somebody merged.
 *
 * The bar, stated positively: a release task READS, or writes something whose
 * previous value nobody depends on, and doing it twice is the same as doing it
 * once.
 */
export interface ReleaseTask {
  /** Stable across versions — it is half the ledger's unique key. */
  name: string;
  /**
   * Do the work. Anything returned is stored as the row's `detail`, so return
   * what an operator would want months later ("published 2 prompts, skipped
   * 3"), not a status the outcome column already carries.
   *
   * Throwing marks the run `failed` and it is retried on the next boot of the
   * SAME version — a redeploy of the same SHA, or a restarted container.
   */
  run: () => Promise<Record<string, unknown> | void>;
}
