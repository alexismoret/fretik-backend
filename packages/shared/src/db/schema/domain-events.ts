import { sql } from "drizzle-orm";
import {
  decimal,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";
import { collectionRecords } from "./collection-records";
// `domainEventActorEnum` lives in `ontology-enums.ts` (so `collection-records` can
// use it for actor stamps without a circular import — this module imports
// `collection_records` for its provenance FK). The schema barrel exports it once,
// from there.
import {
  domainEventActorEnum,
  ontologySourceEnum,
  ontologyStatusEnum,
} from "./ontology-enums";

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
    // Which agent produced the event when actorType is agent/workflow —
    // "chatbot" today, "workflow:<key>" once the engine lands (run ids go in
    // `payload`, not a column: no workflow tables exist to FK against).
    agentKey: varchar("agent_key", { length: 60 }),
    conversationId: uuid("conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    // Denormalized convenience subject (the real graph is domain_event_links).
    subjectType: varchar("subject_type", { length: 60 }),
    subjectRecordId: uuid("subject_record_id").references(
      () => collectionRecords.id,
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
      .references(() => collectionRecords.id, { onDelete: "cascade" }),
    // subject | mentioned | created | affected
    role: varchar("role", { length: 60 }).notNull().default("mentioned"),
    // Trust of the edge. Links written at the mutation source are exact
    // (confidence NULL, confirmed/system). The async resolver's inferred
    // mentions carry their match confidence and land `confirmed` at
    // ≥ RESOLUTION_AUTO_THRESHOLD, `suggested` in the review band below it.
    confidence: decimal("confidence", { precision: 4, scale: 3 }),
    status: ontologyStatusEnum("status").notNull().default("confirmed"),
    source: ontologySourceEnum("source").notNull().default("system"),
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
