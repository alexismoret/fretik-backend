import { and, asc, desc, eq, gt, lt, lte, sql } from "drizzle-orm";
import db from "../../db";
import type { DomainEvent } from "../../db/schema";
import { domainEvents, workerCursors } from "../../db/schema";

/**
 * Journal consumption for background consumers (the memory sweep today, the
 * workflow trigger engine tomorrow). `domain_events.id` is uuid v7 —
 * time-ordered — so the PK doubles as an exact keyset cursor (`id > cursor`
 * never loses or re-reads events sharing a millisecond, which a bare
 * timestamp cursor would). The freshness bound rides the `recorded_at`
 * column: `recorded_at <= now() - watermark` keeps events committed late by
 * an open transaction from slipping behind an already-advanced cursor (an
 * event's `recorded_at` is its INSERT time, always ≤ its commit time).
 */

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Read a named cursor, creating it at the journal's current tail on first
 * use. A brand-new consumer starts at "now" — historical events are handled
 * by explicit backfills, never by sweeping the whole journal on first boot.
 */
export const ensureWorkerCursor = async (name: string): Promise<string> => {
  const [existing] = await db
    .select({ position: workerCursors.position })
    .from(workerCursors)
    .where(eq(workerCursors.name, name));
  if (existing) return existing.position;

  // No max(uuid) aggregate in Postgres — take the PK-index tail instead.
  const [tail] = await db
    .select({ position: domainEvents.id })
    .from(domainEvents)
    .orderBy(desc(domainEvents.id))
    .limit(1);
  const initial = tail?.position ?? NIL_UUID;
  const [inserted] = await db
    .insert(workerCursors)
    .values({ name, position: initial })
    .onConflictDoNothing()
    .returning({ position: workerCursors.position });
  // A concurrent replica may have won the insert — its position stands.
  if (inserted) return inserted.position;
  return ensureWorkerCursor(name);
};

/** The next batch after `after`, older than the watermark. */
export const readEventsAfter = async (input: {
  after: string;
  watermarkMs: number;
  limit: number;
}): Promise<DomainEvent[]> =>
  db
    .select()
    .from(domainEvents)
    .where(
      and(
        gt(domainEvents.id, input.after),
        lte(
          domainEvents.recordedAt,
          sql`now() - make_interval(secs => ${input.watermarkMs / 1000})`,
        ),
      ),
    )
    .orderBy(asc(domainEvents.id))
    .limit(input.limit);

/**
 * Advance a cursor monotonically — a stale concurrent sweep can never move it
 * backwards (its enqueue side is already idempotent via per-event jobIds).
 */
export const advanceWorkerCursor = async (input: {
  name: string;
  position: string;
}): Promise<void> => {
  await db
    .update(workerCursors)
    .set({ position: input.position })
    .where(
      and(
        eq(workerCursors.name, input.name),
        lt(workerCursors.position, input.position),
      ),
    );
};

/** Health introspection: every cursor with its last-advance time. */
export const listWorkerCursors = async (): Promise<
  { name: string; position: string; updatedAt: Date }[]
> => db.select().from(workerCursors);
