import { and, eq, inArray, isNotNull } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { domainEventLinks, domainEvents } from "../../db/schema";
import { chunkForBulk } from "../../lib/db-bulk";
import { internalError, throwHttpError } from "../../lib/errors";
import type { EventActor } from "./emit";
import {
  assertValidDomainEventType,
  type DomainEventType,
} from "./event-types";
import type { EventRecordLink } from "./link-records";

/** One journal entry of a bulk emit. */
export interface BulkDomainEvent {
  type: DomainEventType;
  subjectType?: string | null;
  subjectRecordId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
  /**
   * Deterministic idempotence key (`record.created:{id}`), or omitted for
   * event kinds with no natural once-only token (`record.updated`).
   */
  dedupKey?: string | null;
  recordLinks?: EventRecordLink[];
}

/**
 * The set-based sibling of `emitDomainEvent` — one multi-row INSERT of journal
 * entries + one of their record links per chunk, never a query per event. Same
 * idempotence contract: a `dedupKey` collision returns the prior entry's id
 * instead of inserting a duplicate. Returns ids ALIGNED with `events` order so
 * callers can stamp `source_event_id` back positionally. One team per call
 * (a team belongs to exactly one organization).
 */
export const emitDomainEventsBulk = async (input: {
  tx?: Transaction;
  organizationId: string;
  teamId: string;
  actor: EventActor;
  events: BulkDomainEvent[];
}): Promise<{ ids: string[] }> => {
  if (input.events.length === 0) return { ids: [] };
  for (const e of input.events) assertValidDomainEventType(e.type);
  const exec = input.tx ?? db;

  const ids: string[] = new Array<string>(input.events.length);
  const indexed = input.events.map((event, index) => ({ event, index }));

  for (const chunk of chunkForBulk(indexed)) {
    // Only keyed rows can hit the dedup partial unique index — split so each
    // arm keeps positional RETURNING alignment (unkeyed rows always insert;
    // keyed rows may be omitted by ON CONFLICT and are re-fetched by key).
    const keyed: { event: BulkDomainEvent; index: number; dedupKey: string }[] =
      [];
    const unkeyed: { event: BulkDomainEvent; index: number }[] = [];
    for (const item of chunk) {
      if (item.event.dedupKey != null) {
        keyed.push({ ...item, dedupKey: item.event.dedupKey });
      } else {
        unkeyed.push(item);
      }
    }

    const toValues = ({ event }: { event: BulkDomainEvent }) => ({
      organizationId: input.organizationId,
      teamId: input.teamId,
      type: event.type,
      actorType: input.actor.actorType,
      actorUserId: input.actor.actorUserId ?? null,
      agentKey: input.actor.agentKey ?? null,
      conversationId: input.actor.conversationId ?? null,
      subjectType: event.subjectType ?? null,
      subjectRecordId: event.subjectRecordId ?? null,
      payload: event.payload ?? {},
      dedupKey: event.dedupKey ?? null,
      ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    });

    if (unkeyed.length > 0) {
      const inserted = await exec
        .insert(domainEvents)
        .values(unkeyed.map(toValues))
        .returning({ id: domainEvents.id });
      inserted.forEach((row, i) => {
        ids[unkeyed[i]!.index] = row.id;
      });
    }

    if (keyed.length > 0) {
      const inserted = await exec
        .insert(domainEvents)
        .values(keyed.map(toValues))
        .onConflictDoNothing()
        .returning({ id: domainEvents.id, dedupKey: domainEvents.dedupKey });
      const idByKey = new Map(inserted.map((r) => [r.dedupKey, r.id]));
      const missing = keyed
        .map(({ dedupKey }) => dedupKey)
        .filter((k) => !idByKey.has(k));
      if (missing.length > 0) {
        const prior = await exec
          .select({ id: domainEvents.id, dedupKey: domainEvents.dedupKey })
          .from(domainEvents)
          .where(
            and(
              eq(domainEvents.teamId, input.teamId),
              isNotNull(domainEvents.dedupKey),
              inArray(domainEvents.dedupKey, missing),
            ),
          );
        for (const r of prior) idByKey.set(r.dedupKey, r.id);
      }
      for (const { dedupKey, index } of keyed) {
        const id = idByKey.get(dedupKey);
        if (!id) return throwHttpError(500, internalError());
        ids[index] = id;
      }
    }

    const linkRows = chunk.flatMap(({ event, index }) =>
      (event.recordLinks ?? []).map((l) => ({
        eventId: ids[index]!,
        recordId: l.recordId,
        role: l.role ?? "mentioned",
        confidence: l.confidence != null ? String(l.confidence) : null,
        status: l.status ?? "confirmed",
        source: l.source ?? "system",
      })),
    );
    if (linkRows.length > 0) {
      await exec
        .insert(domainEventLinks)
        .values(linkRows)
        .onConflictDoNothing({
          target: [
            domainEventLinks.eventId,
            domainEventLinks.recordId,
            domainEventLinks.role,
          ],
        });
    }
  }

  return { ids };
};
