import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";
import { collectionRecords } from "./collection-records";

/**
 * What an episode distills:
 *   - conversation    — one chatbot conversation (re-distilled on quiet)
 *   - record_activity — a record's recent event cluster (nightly digest)
 *   - consolidated    — a "dreaming" merge of overlapping episodes
 */
export const aiEpisodeKindEnum = pgEnum("ai_episode_kind", [
  "conversation",
  "record_activity",
  "consolidated",
]);

/**
 * Lifecycle. Nothing is ever deleted:
 *   - active     — in the recall index (vectorized in ai_vectors)
 *   - demoted    — unrecalled ≥ 90d; vectors dropped, row kept (`demotedAt`
 *                  stamps it for an eventual much-later purge)
 *   - superseded — replaced by a consolidation merge / revision
 *                  (`supersededById` points at the survivor)
 */
export const aiEpisodeStateEnum = pgEnum("ai_episode_state", [
  "active",
  "demoted",
  "superseded",
]);

/**
 * Episodic memory — distilled "what happened" summaries (conversations,
 * record activity, consolidation merges), the L3 tier between the raw
 * `domain_events` journal and per-turn recall. Source of truth here;
 * `ai_vectors` (`source_type='episodes'`) is the derived recall index —
 * same pattern as `ai_memories`. Not SQL-tool visible (no grant, RLS off):
 * the agent reaches episodes through recall and `searchKnowledge` only.
 */
export const aiEpisodes = pgTable(
  "ai_episodes",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    // Set = PRIVATE to that user (episodes of single-member conversations).
    // NULL = team-visible (multi-member conversations, record activity,
    // consolidated). Cascade: deleting a user deletes their private episodes.
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),

    kind: aiEpisodeKindEnum("kind").notNull(),
    state: aiEpisodeStateEnum("state").notNull().default("active"),

    title: text("title").notNull(),
    // Distilled markdown, service-capped (~4KB) — never raw transcripts.
    summary: text("summary").notNull(),

    // What the episode was distilled FROM (kind-dependent, both nullable).
    conversationId: uuid("conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),
    anchorRecordId: uuid("anchor_record_id").references(
      () => collectionRecords.id,
      { onDelete: "set null" },
    ),

    // The real-world window the episode covers.
    occurredFrom: timestamp("occurred_from", { withTimezone: true }),
    occurredTo: timestamp("occurred_to", { withTimezone: true }),

    // Non-destructive supersession (consolidation merge / contradiction).
    supersededById: uuid("superseded_by_id").references(
      (): AnyPgColumn => aiEpisodes.id,
      { onDelete: "set null" },
    ),

    // SHA-256 of title+summary — unchanged hash skips the re-embed roundtrip.
    contentHash: text("content_hash").notNull(),

    // Recall usage — stamped by the recall pipeline, read by the demotion GC.
    lastRecalledAt: timestamp("last_recalled_at", { withTimezone: true }),
    recallCount: integer("recall_count").notNull().default(0),
    demotedAt: timestamp("demoted_at", { withTimezone: true }),

    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    // One ACTIVE episode per conversation — the distiller's upsert key.
    uniqueIndex("ai_episodes_conversation_active_uniq")
      .on(table.conversationId)
      .where(sql`kind = 'conversation' AND state = 'active'`),
    // One ACTIVE digest per anchor record.
    uniqueIndex("ai_episodes_record_activity_active_uniq")
      .on(table.anchorRecordId)
      .where(sql`kind = 'record_activity' AND state = 'active'`),
    // The demotion GC's scan path.
    index("ai_episodes_team_state_recalled_idx").on(
      table.teamId,
      table.state,
      table.lastRecalledAt,
    ),
    index("ai_episodes_team_kind_idx").on(table.teamId, table.kind),
  ],
);

/**
 * Episode ↔ record anchoring — which records an episode is about (chosen
 * from the underlying events' `domain_event_links`, never model-invented).
 * The recall pipeline's graph arm: "recent episodes about this record".
 */
export const aiEpisodeRecords = pgTable(
  "ai_episode_records",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => aiEpisodes.id, { onDelete: "cascade" }),
    recordId: uuid("record_id")
      .notNull()
      .references(() => collectionRecords.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("ai_episode_records_uniq").on(table.episodeId, table.recordId),
    index("ai_episode_records_record_idx").on(table.recordId),
  ],
);

export type AiEpisode = typeof aiEpisodes.$inferSelect;
export type NewAiEpisode = typeof aiEpisodes.$inferInsert;
export type AiEpisodeKind = AiEpisode["kind"];
export type AiEpisodeState = AiEpisode["state"];
export type AiEpisodeRecord = typeof aiEpisodeRecords.$inferSelect;
