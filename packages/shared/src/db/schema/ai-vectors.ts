import { sql } from "drizzle-orm";
import {
  check,
  customType,
  halfvec,
  index,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, team, user } from "./auth-schema";

/*
 * Postgres `tsvector` column type for BM25 full-text search.
 * Drizzle does not ship a native tsvector column, so we wrap it via customType.
 * Used by ai_vectors.searchVector as a STORED generated column — Postgres
 * auto-populates it on every INSERT/UPDATE via `to_tsvector('english', ...)`.
 */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

/*
 * AI vector source type — Postgres enum.
 * Backs the `ai_vectors.source_type` column. Values are locked at the DB
 * layer so new source kinds require a schema migration (and an intentional
 * review of the RAG / vectorize / chatbot-tool code paths that branch on
 * source type). Follow the same pattern as every other shared pgEnum in
 * this package: export the enum itself, the tuple of enumValues, and a
 * derived TypeScript union. Callers in @fretik/ai, @fretik/api and
 * @fretik/worker MUST import from here instead of re-declaring the union
 * inline.
 *
 * Source kinds:
 *   - 'documents': team-owned uploaded documents (contracts, invoices, etc.)
 *   - 'memories' : agent-writable memory store (team or user-scoped)
 *   - 'skills'   : SKILL.md content for progressive skill discovery
 *   - 'context'  : Projects-style persistent context files (team or user)
 *   - 'episodes' : distilled episodic memory (`ai_episodes` is the source of
 *                  truth; team or user-scoped)
 *   - 'records'  : record "cards" (label + aliases + type + key text fields)
 *                  for semantic record search — confirmed records only
 *   - 'workflows': what a workflow does and what it takes, so the assistant
 *                  finds an existing one from a request that never says
 *                  "workflow" — and never builds a duplicate
 *   - 'pages'    : what a page shows and who it is for, so the assistant
 *                  points at the dashboard the team already has instead of
 *                  rebuilding it
 */
export const aiVectorSourceTypeEnum = pgEnum("ai_vector_source_type", [
  "documents",
  "memories",
  "skills",
  "context",
  "episodes",
  "records",
  "workflows",
  "pages",
]);

export const AI_VECTOR_SOURCE_TYPES = aiVectorSourceTypeEnum.enumValues;
export type AiVectorSourceType = (typeof AI_VECTOR_SOURCE_TYPES)[number];

/*
 * Metadata types for AI vectors.
 * Each source_type has its OWN metadata structure stored in the JSONB column.
 * Universal fields (team_id, organization_id, user_id, source_type, source_id)
 * are NEVER duplicated in metadata — they live on dedicated table columns and
 * callers read them from there. Only source-specific fields belong in this
 * JSONB.
 */

// A record mentioned by a document, embedded into the document's vectors so RAG
// can filter / cite by it. `type` is the object-type key (e.g. "company") and
// `role` the relation key (e.g. "mentions"). The JSONB field stays named
// `entities` for back-compat with already-indexed vectors.
type MentionVectorInfo = {
  id: string;
  name: string;
  type: string;
  role: string;
};

/**
 * Document vector metadata. Universal AI outputs (page count, language,
 * summary, entities) ride as named fields; industry-specific outputs flow
 * through `custom_fields` keyed by the team's field definition slugs.
 * The semantic header prepended to each chunk before embedding is built
 * dynamically from the field definitions whose `vectorizeInclude` is true.
 */
type DocumentVectorMetadata = {
  file_name: string;
  file_type: string;
  page_count: number | null;
  document_language: string | null;
  document_summary: string | null;
  entities: MentionVectorInfo[];
  /**
   * Team-configurable custom field values keyed by `fieldDefinitions.key`.
   * Primitives are stored as JSON primitives; multi_select as string[].
   */
  custom_fields: Record<string, string | number | boolean | string[] | null>;
  is_metadata_only?: boolean;
};

/*
 * Metadata for `source_type='memories'` rows. The agent-writable memory
 * store (`ai_memories`) is the source of truth — this JSONB only carries
 * fields useful for filtering / display at retrieval time and that aren't
 * already on dedicated columns. `scope` and `path` are duplicated here
 * (vs joining back to `ai_memories`) so the chatbot can render citations
 * and apply scope-aware UX without an extra round-trip.
 */
type MemoryVectorMetadata = {
  scope: "user" | "team";
  path: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};

/*
 * Metadata for `source_type='skills'` rows. Skills are GLOBAL (no team /
 * org / user scope — `team_id`, `organization_id`, `user_id` are all
 * NULL). The bundled skill source files live under
 * `@fretik/ai/src/skills/bundled/<name>/` (SKILL.md + references/*.md);
 * scripts/*.py are runtime-loaded code, not for retrieval.
 *
 * Indexing strategy (cf. S3 of the RAG-unification refactor):
 *   - one row group per .md file (multi-source_id per skill).
 *   - `(skill_name, skill_file)` is the lookup key for re-indexing —
 *     the boot hook calls `getOrMintSourceId(name, file)` to either
 *     reuse the existing source_id or mint a fresh `Bun.randomUUIDv7()`.
 *   - `content_hash` (SHA-256 hex) acts as the idempotence guard: if it
 *     hasn't changed since the last indexing, the boot hook skips the
 *     embed roundtrip entirely.
 */
type SkillVectorMetadata = {
  skill_name: string;
  skill_file: string;
  skill_description: string;
  content_hash: string;
  version_indexed_at: string;
};

/*
 * Metadata for `source_type='context'` rows. Context files (admin- or
 * user-uploaded PDFs / DOCX / spreadsheets / markdown that scope what the
 * chatbot knows about a team or user) are vectorised at the moment they
 * reach `aiContextFiles.status='ready'` (post-Mistral OCR). The agent
 * surfaces them through `searchKnowledge` instead of carrying their full
 * markdown in the system prompt.
 *
 * `scope` and `filename` are duplicated from the parent
 * `aiContextFiles` row so retrieval-time consumers can render citations
 * without joining back; `team_id`, `organization_id`, `user_id`,
 * `source_type`, `source_id` stay on dedicated columns. `profile_id`
 * is the FK target for parent-profile lookups in the settings UI.
 */
type ContextVectorMetadata = {
  scope: "user" | "team";
  filename: string;
  mime_type: string;
  size_bytes: number;
  profile_id: string;
  created_at: string;
  updated_at: string;
};

/*
 * Metadata for `source_type='episodes'` rows. `ai_episodes` is the source of
 * truth; these fields ride along for citation rendering + recall filtering
 * without a join back. `source_id` = the episode id.
 */
type EpisodeVectorMetadata = {
  kind: "conversation" | "record_activity" | "consolidated";
  title: string;
  conversation_id: string | null;
  anchor_record_id: string | null;
  occurred_from: string | null;
  occurred_to: string | null;
};

/*
 * Metadata for `source_type='records'` rows — one "card" per CONFIRMED
 * record (label + aliases + type + key text fields), refreshed
 * async on record create/update, deleted with the record. Powers semantic
 * record search ("the client in Lyon") in recall + `searchKnowledge`.
 * `source_id` = the record id; single chunk per record.
 */
type RecordVectorMetadata = {
  collection_id: string;
  collection_key: string;
  label: string;
};

/*
 * Metadata for `source_type='workflows'` rows — one card per workflow
 * (what it does, how it is triggered, what it takes as input), refreshed on
 * every definition change and deleted with the workflow. `source_id` = the
 * workflow id; single chunk, like records.
 */
type WorkflowVectorMetadata = {
  name: string;
  description: string;
  trigger_type: string;
  status: string;
  task_count: number;
  content_hash: string;
  version_indexed_at: string;
};

/*
 * Metadata for `source_type='pages'` rows — one card per page (what it shows,
 * who it is for, what it can do), refreshed on every save and deleted with the
 * page. `source_id` = the page id; single chunk, like records and workflows.
 *
 * `published` rides along because "can I hand this to someone outside the
 * team" is half of what makes a page the right answer to a request.
 */
type PageVectorMetadata = {
  name: string;
  job: string;
  published: boolean;
  content_hash: string;
  version_indexed_at: string;
};

export type AiVectorMetadata =
  | DocumentVectorMetadata
  | MemoryVectorMetadata
  | SkillVectorMetadata
  | ContextVectorMetadata
  | EpisodeVectorMetadata
  | RecordVectorMetadata
  | WorkflowVectorMetadata
  | PageVectorMetadata;

export type {
  ContextVectorMetadata,
  DocumentVectorMetadata,
  EpisodeVectorMetadata,
  MemoryVectorMetadata,
  MentionVectorInfo,
  PageVectorMetadata,
  RecordVectorMetadata,
  SkillVectorMetadata,
  WorkflowVectorMetadata,
};

/*
 * AI vectors table
 * Unified RAG vector store for all knowledge sources: documents, memories,
 * skills, context files. Discriminated by `source_type`.
 *
 * Scope model (S3 of the RAG-unification refactor):
 *   - tenant-scoped rows: both `team_id` and `organization_id` are NOT NULL
 *     (documents, team/user memories, team/user context).
 *   - global rows: both `team_id` and `organization_id` are NULL
 *     (currently: bundled skills shipped with @fretik/ai). The
 *     `ai_vectors_scope_consistency` CHECK enforces the (both-or-neither)
 *     invariant at the DB layer; the partial index `idx_ai_vectors_global`
 *     (`source_type WHERE team_id IS NULL`) is the hot path for the
 *     planner when `searchKnowledge` reaches for global content.
 *   - `user_id` is an additional optional discriminator on top of the
 *     tenant scope (memories user / context user); always NULL for
 *     global rows.
 */
export const aiVectors = pgTable(
  "ai_vectors",
  {
    id: uuid("id")
      .default(sql`uuid_generate_v7()`)
      .primaryKey(),

    // Content of the chunk (written by the @fretik/ai vectorize service)
    content: text("content").notNull(),

    // Source-specific metadata (JSONB). Universal fields
    // (team_id, organization_id, user_id, source_type, source_id) are written
    // to dedicated columns below — never duplicated here.
    metadata: jsonb("metadata").$type<AiVectorMetadata>().notNull(),

    // Contextualized prefix (Anthropic Contextual Retrieval pattern).
    // 50-100 tokens of chunk-specific context, prepended before embedding
    // and before BM25 indexing. Generated per chunk by gpt-oss-20b at ingest.
    contextualPrefix: text("contextual_prefix").notNull(),

    // Chunk position inside the source document (0-based).
    chunkIndex: smallint("chunk_index").notNull(),

    // Total number of chunks produced for the source document.
    // Allows the reader to reconstruct ordering and display progress.
    totalChunks: smallint("total_chunks").notNull(),

    // Embedding vector — Qwen3-Embedding-8B truncated to 2560 dims via
    // Matryoshka Representation Learning (OpenRouter `dimensions` param).
    // halfvec stores fp16 (2 bytes/dim) — HNSW supports halfvec up to 4000
    // dims while the plain `vector` type caps at 2000 dims.
    embedding: halfvec("embedding", { dimensions: 2560 }),

    // BM25 full-text search vector (GIN-indexed).
    // GENERATED STORED column — Postgres auto-populates it at INSERT/UPDATE
    // from (contextual_prefix || ' ' || content). No trigger needed;
    // to_tsvector(regconfig, text) is IMMUTABLE in PG 12+ which is the
    // prerequisite for using it in a generated column expression.
    //
    // Config = 'simple' (NOT 'english'): the chatbot indexes multilingual
    // content (FR / ES / DE / IT / NL + EN business documents, summaries, etc.)
    // and we don't reliably track per-row language (summaries have no lang
    // field), so we can't dispatch to a per-language
    // regconfig via a CASE expression. 'simple' tokenizes on whitespace and
    // punctuation with no stemming and no stopwords — it works uniformly for
    // all Latin-script languages and is the industry default for mixed-language
    // BM25 when per-row language dispatch is not viable (Elastic uses the
    // same pattern via their 'standard' / ICU fallback analyzer).
    //
    // Why keep BM25 at all (vs SPLADE / BGE-M3 sparse / dense-only):
    //   (1) Fretik business documents are dense in exact identifiers
    //       — invoice numbers, contract numbers, PO numbers, reference IDs,
    //       company names, project codes. These are BM25's sweet spot; learned
    //       sparse models (SPLADE / BGE-M3) don't add value on proper nouns
    //       and codes.
    //   (2) Dense-only is a known anti-pattern in 2026 production RAG — it
    //       misses exact matches. Anthropic's own benchmark shows +6.06% from
    //       adding BM25 on top of Contextual Embeddings.
    //   (3) BM25 in Postgres costs exactly zero: a GENERATED STORED column +
    //       a GIN index, no extra inference pass, no second provider.
    //   (4) SPLADE / BGE-M3 sparse would require either sacrificing Qwen3
    //       (Qwen3-Embedding-8B is #1 MMTEB multilingual, ~3 points ahead of
    //       BGE-M3 dense) or running two embedding models in parallel.
    //       Not worth the complexity when BM25 covers Fretik's exact-match
    //       use case natively.
    //
    // Expected ~5-10% recall loss vs a language-specific analyzer on the
    // non-EN subset is acceptable because:
    //   (a) weighted RRF in Phase 7c gives BM25 only 20% weight vs 80%
    //       semantic (Qwen3-Embedding-8B handles morphological variation
    //       natively — it's #1 on MMTEB multilingual),
    //   (b) BM25's primary job in this stack is exact-term match on proper
    //       nouns, codes, IDs, and technical terms — none of which benefit
    //       from stemming anyway.
    //
    // Upgrade path (Phase 11+, not needed for V1): add a third retrieval leg
    // via `sparse_embedding sparsevec(N)` column + BGE-M3 sparse output.
    // Fuse via weighted RRF across three signals (semantic + sparse-learned +
    // BM25) — no regression risk, just additive. Revisit if (1) CJK documents
    // appear (simple tokenizes them character-by-character — unusable), or
    // (2) Phase 10 Promptfoo evals show >5% recall loss on the non-EN subset.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce("contextual_prefix", '') || ' ' || coalesce("content", ''))`,
    ),

    // Universal row-level columns — written as plain values by the
    // @fretik/ai vectorize service.
    sourceType: aiVectorSourceTypeEnum("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    // Tenant scope. NULL on both columns means "global row" (currently
    // bundled skills); the `ai_vectors_scope_consistency` CHECK below
    // forbids mixed states (one NULL + one set). FKs stay ON DELETE
    // CASCADE so wiping a team / org also wipes its vector rows.
    teamId: uuid("team_id").references(() => team.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    // Optional user scope for sources that can be either team-shared
    // (NULL) or owned by an individual user — currently used by memories
    // (user-scope) and context files (user-scope). Documents and skills
    // always leave this NULL.
    userId: uuid("user_id").references(() => user.id, { onDelete: "cascade" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    // B-tree index on team_id (mandatory filter for every RAG query)
    index("idx_ai_vectors_team_id").on(table.teamId),

    // B-tree index on organization_id (organization-wide queries)
    index("idx_ai_vectors_organization_id").on(table.organizationId),

    // Composite index source_type + source_id (for upsert DELETE)
    index("idx_ai_vectors_source").on(table.sourceType, table.sourceId),

    // Composite index team_id + created_at DESC (chronological per team)
    index("idx_ai_vectors_team_created").on(table.teamId, table.createdAt),

    // GIN index on metadata JSONB for flexible filtering
    index("idx_ai_vectors_metadata_gin").using("gin", table.metadata),

    // GIN index on the generated tsvector column for BM25 full-text search.
    index("idx_ai_vectors_search_vector").using("gin", table.searchVector),

    // HNSW index on the halfvec embedding for ANN cosine similarity search.
    // m=16 / ef_construction=200 are the production defaults validated by
    // Crunchy Data, Neon and AWS Aurora for 768-2560 dim embeddings.
    // Query time: SET LOCAL hnsw.ef_search = 100 (default 40 is too low for
    // high-recall RAG).
    index("idx_ai_vectors_embedding_hnsw")
      .using("hnsw", table.embedding.op("halfvec_cosine_ops"))
      .with({ m: 16, ef_construction: 200 }),

    // Partial composite index for user-scoped sources. Speeds up
    // (team_id, user_id) prefilters before the HNSW scan when the chatbot
    // queries memories/context with a user-scope filter — matches the
    // pgvector multi-tenant pattern (B-tree prefilter narrows the candidate
    // set, HNSW does the ANN). Only covers sources that can be user-owned
    // (memories + context). Documents and skills always leave user_id NULL
    // so they don't benefit from this index.
    index("idx_ai_vectors_team_user_partial")
      .on(table.teamId, table.userId)
      .where(sql`source_type IN ('memories', 'context')`),

    // Tenant scope coherence — 3-arm shape, one branch per source-type
    // family with its own scope rules. Tightest possible constraint so a
    // future contributor's typo surfaces at INSERT instead of leaking
    // into retrieval. Adding a new source_type requires editing this
    // CHECK + thinking about which arm it belongs in.
    //   - skills: GLOBAL — team_id, organization_id, user_id all NULL.
    //   - context: TENANT-scoped with optional team_id (user-scope
    //     context profiles have no team but always belong to an org;
    //     team-scope profiles have both). organization_id is therefore
    //     mandatory; team_id is optional. user_id follows scope at the
    //     application layer.
    //   - everything else (documents, memories, episodes, records,
    //     workflows, pages): TENANT-scoped, both team_id and
    //     organization_id mandatory. `user_id` stays optional here — a
    //     private workflow or page carries its owner, a team-shared one
    //     leaves it NULL.
    check(
      "ai_vectors_scope_consistency",
      sql`(${table.sourceType} = 'skills' AND ${table.teamId} IS NULL AND ${table.organizationId} IS NULL AND ${table.userId} IS NULL) OR (${table.sourceType} = 'context' AND ${table.organizationId} IS NOT NULL) OR (${table.sourceType} NOT IN ('skills', 'context') AND ${table.teamId} IS NOT NULL AND ${table.organizationId} IS NOT NULL)`,
    ),

    // Hot-path index for global rows. The `searchKnowledge` filter
    // (S5 of the RAG-unification refactor) will reach for skills via
    // `team_id IS NULL` — the partial index lets the planner satisfy
    // that predicate without scanning the tenant-scoped majority.
    // Indexing on `source_type` keeps the leaf size minimal while still
    // supporting `WHERE source_type = 'skills' AND team_id IS NULL`.
    index("idx_ai_vectors_global")
      .on(table.sourceType)
      .where(sql`team_id IS NULL`),
  ],
);

export type AiVector = typeof aiVectors.$inferSelect;
export type NewAiVector = typeof aiVectors.$inferInsert;
