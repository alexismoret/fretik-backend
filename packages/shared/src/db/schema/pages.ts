import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
// The definition shape lives in the db-free `schemas/pages.ts` (same split as
// workflows/skills): the jsonb columns are typed by its inferred type, so the
// contract is declared once and drizzle-kit sees no schema-parse cycle (the
// reverse edge is type-only, erased at runtime).
import type { PageDefinition, PageRuntimeError } from "../../schemas/pages";
import { aiConversations } from "./ai";
import { organization, team, user } from "./auth-schema";

/**
 * A page = a data-bound UI document the agent authors and the frontend
 * renders deterministically (no LLM at view time). Scoped by the same
 * org→team→(optional user) triad as workflows: `userId` NULL = team-shared,
 * set = private to that user.
 *
 * Publishing is the only lifecycle gate — there is no draft/active enum,
 * because a page has no "run": an incomplete page still renders for its own
 * team. `publishedDefinition` is a snapshot of the DEFINITION (not of the
 * data) taken at publish, so later edits never reach the public URL until
 * republished, while the data the public page shows stays live.
 */
export const pages = pgTable(
  "pages",
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
    userId: uuid("user_id").references(() => user.id, { onDelete: "set null" }),

    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").notNull().default(""),
    // Same icon/color convention as collections and workflows (Lucide name +
    // semantic color token).
    icon: varchar("icon", { length: 60 }),
    color: varchar("color", { length: 20 }),

    definition: jsonb("definition").$type<PageDefinition>().notNull(),

    // Ring buffer of the most recent runtime errors the sandboxed page
    // reported through the bridge (`POST /pages/{id}/errors`) — the agent's
    // self-heal feed, surfaced by managePage get/update.
    runtimeErrors: jsonb("runtime_errors")
      .$type<PageRuntimeError[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    // Opaque token keying the public URL (`/p/<token>`); NULL = unpublished.
    // Decoupled from the page id (which appears in authed responses/logs),
    // unique-indexed for O(1) public lookup, and rotatable.
    publicToken: uuid("public_token").unique(),
    // Definition frozen at publish — what the public URL serves.
    publishedDefinition: jsonb("published_definition").$type<PageDefinition>(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedByUserId: uuid("published_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    /**
     * Out of the way, not gone: an archived page renders at its own URL and
     * appears in no listing — not the team's hub, not `managePage list`.
     *
     * It exists because the eval harness needed the opposite of a delete. Its
     * runs cost real money and their output IS the evidence — a score says a
     * page was worth 6.8, only the page says why — but a page left standing is
     * a page the next run's agent finds, and an agent that finds a page already
     * covering the ask is RIGHT to stop and ask which one to change (measured
     * 2026-09-04: two cases scored 0.188 and 0.250 for exactly that). Deleting
     * destroys the evidence; archiving keeps it and takes it out of the way.
     */
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    // Provenance: the chat that authored this page, for "open the
    // conversation that built this".
    sourceConversationId: uuid("source_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),
    createdByUserId: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdateFn(() => new Date()),
  },
  (t) => [
    index("pages_team_idx").on(t.teamId, t.updatedAt),
    index("pages_org_idx").on(t.organizationId),
  ],
);

/**
 * One saved state of a page, so a write is never the end of the previous one.
 *
 * Pages were the last first-class deliverable without a net: documents have
 * `document_versions`, memories have `ai_memory_history`, and a page — the
 * surface the agent rewrites MOST, under an `auto` policy, sometimes several
 * times inside one build — had nothing. A single unlucky `edits` was
 * unrecoverable.
 *
 * Modelled on `ai_memory_history` rather than `document_versions`: a document
 * version is a POINTER to S3 because a document can be a 10 MB PDF, while a
 * page definition is tens of KB of JSON that belongs in a column. Storing the
 * whole DEFINITION and not just the source is deliberate — datasets,
 * operations and the brief change too, and restoring source alone would
 * resurrect code against a contract that no longer matches it.
 *
 * `code.compiled` is stripped before writing: it is ~2.5x the source, it is
 * derived, and `ensurePageCompiled` rebuilds it on restore.
 *
 * Retention: latest 20 per page, trimmed post-INSERT — same strategy, same
 * reason, as the two tables above.
 */
export const pageVersions = pgTable(
  "page_versions",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    /**
     * `set null` on page delete, mirroring `ai_memory_history`: the rows
     * outlive the page so "who deleted what, and when" survives, carried by
     * the denormalised `teamId` and `name`.
     */
    pageId: uuid("page_id").references(() => pages.id, {
      onDelete: "set null",
    }),

    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),

    /** 1-based, monotonic per page. */
    versionNumber: integer("version_number").notNull(),

    /**
     * `'create' | 'update' | 'restore' | 'review-round'`. Text, not an enum,
     * so a new kind of write needs no migration. `review-round` is the
     * builder's own checkpoint — see `services/pages/versions.ts`.
     */
    operation: text("operation").notNull(),

    /** The page's definition AFTER this operation, minus `code.compiled`. */
    definition: jsonb("definition").$type<PageDefinition>().notNull(),

    /** Denormalised so a deleted page's history still names itself. */
    name: varchar("name", { length: 120 }).notNull(),

    byUserId: uuid("by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    /** `'user' | 'agent'` — who drove this write. */
    byActor: text("by_actor").notNull(),
    byConversationId: uuid("by_conversation_id").references(
      () => aiConversations.id,
      { onDelete: "set null" },
    ),

    /**
     * Why this state exists: which review round produced it and what the
     * critic scored it, or which version a restore came from.
     */
    meta: jsonb("meta").$type<{
      round?: number;
      score?: number;
      restoredFrom?: number;
    }>(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Two writers racing on one page must collide loudly rather than mint the
    // same version number twice — restoring "version 4" has to mean one state.
    // Rows orphaned by a page delete carry `pageId` NULL, and Postgres treats
    // NULLs as distinct, so they never collide with each other.
    uniqueIndex("page_versions_page_number_unique").on(
      t.pageId,
      t.versionNumber,
    ),
    index("page_versions_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type PageVersion = typeof pageVersions.$inferSelect;
