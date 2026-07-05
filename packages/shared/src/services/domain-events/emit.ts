import db, { type Transaction } from "../../db";
import type {
  DomainEvent,
  DomainEventActor,
  NewDomainEvent,
} from "../../db/schema";
import { domainEvents } from "../../db/schema";
import { internalError, throwHttpError } from "../../lib/errors";
import {
  assertValidDomainEventType,
  type DomainEventType,
} from "./event-types";
import { type EventRecordLink, linkEventToRecords } from "./link-records";

/**
 * Who/what is performing a mutation. Carried onto every domain event so the
 * journal records provenance: user CRUD (`user`), an agent tool-call (`agent`,
 * with its conversation), the document pipeline / seeds (`system`), or an
 * external connector (`connector`). `agentKey` names the agent when actorType
 * is agent/workflow — "chatbot" today, "workflow:<key>" later.
 */
export interface EventActor {
  actorType: DomainEventActor;
  actorUserId?: string | null;
  conversationId?: string | null;
  agentKey?: string | null;
}

/**
 * The fallback actor for mutations with no explicit caller identity — the
 * document pipeline, seeds, maintenance scripts. Direct user / agent writes
 * pass their own `EventActor` instead. Shared so every write service attributes
 * unowned mutations identically.
 */
export const SYSTEM_ACTOR: EventActor = { actorType: "system" };

/**
 * Map the ai-memory actor vocabulary (`agent` | `human`) onto the journal's —
 * the journal enum is canonical; `ai_memories` keeps its two-value audit enum
 * for its own UI. Today only the chatbot's memory tool writes as `agent`, hence
 * the fixed agentKey; a future workflow memory path passes its own EventActor.
 */
export const toDomainEventActor = (input: {
  byActor: "agent" | "human";
  userId?: string | null;
  conversationId?: string | null;
}): EventActor => ({
  actorType: input.byActor === "human" ? "user" : "agent",
  actorUserId: input.userId ?? null,
  conversationId: input.conversationId ?? null,
  ...(input.byActor === "agent" ? { agentKey: "chatbot" } : {}),
});

/**
 * Append one entry to the durable journal — the transactional outbox. ALWAYS
 * runs inside the same transaction as the mutation it records (pass `tx`), so a
 * crash between the write and the journal entry is impossible: both commit or
 * neither does. The single source for memory recall, record attribute-history,
 * and future workflow triggers.
 *
 * `dedupKey` must be DETERMINISTIC (e.g. `document.uploaded:{documentId}`), never
 * random, so a worker/job retry re-emitting the same event is a no-op rather
 * than a duplicate — the existing entry is fetched and returned. `recordLinks`
 * writes the event↔record provenance graph in the same batch.
 */
export const emitDomainEvent = async (input: {
  tx?: Transaction;
  organizationId: string;
  teamId: string;
  type: DomainEventType;
  actor: EventActor;
  subjectType?: string | null;
  subjectRecordId?: string | null;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
  dedupKey?: string | null;
  recordLinks?: EventRecordLink[];
}): Promise<DomainEvent> => {
  assertValidDomainEventType(input.type);
  const exec = input.tx ?? db;

  const values: NewDomainEvent = {
    organizationId: input.organizationId,
    teamId: input.teamId,
    type: input.type,
    actorType: input.actor.actorType,
    actorUserId: input.actor.actorUserId ?? null,
    agentKey: input.actor.agentKey ?? null,
    conversationId: input.actor.conversationId ?? null,
    subjectType: input.subjectType ?? null,
    subjectRecordId: input.subjectRecordId ?? null,
    payload: input.payload ?? {},
    dedupKey: input.dedupKey ?? null,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
  };

  const [inserted] = await exec
    .insert(domainEvents)
    .values(values)
    .onConflictDoNothing()
    .returning();

  // A `dedupKey` collision inserts nothing — fetch the prior entry so the
  // caller (and its record links) stay idempotent across a retry.
  let event = inserted;
  if (!event) {
    if (input.dedupKey) {
      event = await exec.query.domainEvents.findFirst({
        where: { teamId: input.teamId, dedupKey: input.dedupKey },
      });
    }
    if (!event) {
      return throwHttpError(500, internalError());
    }
  }

  if (input.recordLinks && input.recordLinks.length > 0) {
    await linkEventToRecords({
      tx: input.tx,
      eventId: event.id,
      links: input.recordLinks,
    });
  }

  return event;
};
