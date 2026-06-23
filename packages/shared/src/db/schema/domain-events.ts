import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";
import { objectRecords } from "./object-records";

/**
 * Who/what produced a journal entry.
 */
export const domainEventActorEnum = pgEnum("domain_event_actor", [
  "user",
  "agent",
  "system",
  "connector",
]);

/**
 * Domain events — the DURABLE, append-only journal / transactional outbox. Not
 * to be confused with the Redis pub/sub (`upload-events.ts`,
 * `conversation-events.ts`, ephemeral/advisory) or the `activity_logs` UI audit
 * trail (fixed enum). Written INSIDE the mutation's transaction, never
 * fire-and-forget. It is the single source for memory recall, record
 * attribute-history, and (future) workflow triggers.
 *
 * `dedupKey` is deterministic (e.g. `document.uploaded:{documentId}`) so worker
 * retries stay idempotent. `subjectRecordId` is a denormalized convenience; the
 * real provenance graph is `domain_event_links`.
 */
export const domainEvents = pgTable(
  "domain_events",
  {
    // v7 = time-ordered; doubles as a consumption cursor for future workers.
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    // Dotted event name, e.g. record.created | document.uploaded | chat.turn |
    // (future) mail.received. Free text — not an enum — so connectors add kinds
    // without a migration.
    type: text("type").notNull(),
    actorType: domainEventActorEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    // Denormalized convenience subject (the real graph is domain_event_links).
    subjectType: varchar("subject_type", { length: 60 }),
    subjectRecordId: uuid("subject_record_id").references(
      () => objectRecords.id,
      { onDelete: "set null" },
    ),

    // Arbitrary detail — incl. field diffs for record.updated (the basis of
    // attribute-history reconstruction).
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    // When it happened in the world vs when we journaled it.
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),

    // Deterministic idempotence key. Never random.
    dedupKey: text("dedup_key"),
  },
  (table) => [
    index("domain_events_team_occurred_idx").on(table.teamId, table.occurredAt),
    index("domain_events_subject_idx").on(table.subjectRecordId),
    index("domain_events_team_type_idx").on(table.teamId, table.type),
    uniqueIndex("domain_events_dedup_uniq")
      .on(table.teamId, table.dedupKey)
      .where(sql`dedup_key IS NOT NULL`),
  ],
);

/**
 * Event ↔ record provenance graph. "Which records did this event touch, in what
 * role" — and the reverse, "what happened to this record" (the memory-recall +
 * attribute-history hot path).
 */
export const domainEventLinks = pgTable(
  "domain_event_links",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => domainEvents.id, { onDelete: "cascade" }),
    recordId: uuid("record_id")
      .notNull()
      .references(() => objectRecords.id, { onDelete: "cascade" }),
    // subject | mentioned | created | affected
    role: varchar("role", { length: 60 }).notNull().default("mentioned"),
  },
  (table) => [
    uniqueIndex("domain_event_links_uniq").on(
      table.eventId,
      table.recordId,
      table.role,
    ),
    index("domain_event_links_record_idx").on(table.recordId),
  ],
);

export type DomainEvent = typeof domainEvents.$inferSelect;
export type NewDomainEvent = typeof domainEvents.$inferInsert;
export type DomainEventActor = DomainEvent["actorType"];
export type DomainEventLink = typeof domainEventLinks.$inferSelect;
export type NewDomainEventLink = typeof domainEventLinks.$inferInsert;
