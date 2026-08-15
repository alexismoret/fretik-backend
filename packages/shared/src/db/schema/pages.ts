import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
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
    // Same icon/color convention as object_types and workflows (Lucide name +
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

export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
