import type {
  AiVectorMetadata,
  AiVectorSourceType,
  ContextVectorMetadata,
  DocumentVectorMetadata,
  MemoryVectorMetadata,
  SkillVectorMetadata,
} from "@fretik/shared/db/schema";
import { withPipelineTrace } from "../../lib/trace-tool";
import { splitMarkdown } from "./chunker";
import { enrichChunks, type EnrichedChunk } from "./contextual-enrichment";
import { embedBatch } from "./embedder";
import { buildMetadataOnlyText, buildSemanticHeader } from "./format-content";
import { upsertVectors } from "./upsert";

/**
 * End-to-end vectorisation pipeline for a single source document.
 *
 * Pipeline stages (per Phase 7 decisions):
 *   1. `splitMarkdown`    — markdown-aware recursive chunking to ~512
 *                            tokens / ~2000 chars with ~100 token overlap.
 *   2. `enrichChunks`     — Anthropic Contextual Retrieval per-chunk
 *                            prefix via `gpt-oss-20b` (cheap model).
 *   3. `embedBatch`       — Qwen3-Embedding-8B @ `dimensions: 2560`
 *                            on `semanticHeader + contextualPrefix +
 *                            "\n\n" + content`.
 *   4. `upsertVectors`    — DELETE + bulk INSERT inside a single tx.
 *
 * Two distinct ingestion paths:
 *   a. Document with OCR'd markdown → chunk + enrich + embed per chunk.
 *   b. Document WITHOUT OCR content (Excel, CSV) → single synthetic
 *      metadata-only chunk (summary + classification + entities). Same
 *      upsert target table; `metadata.is_metadata_only = true` marks the
 *      row so downstream tooling can distinguish.
 *
 * Design notes:
 *   - metadata semantic header is prepended to EVERY chunk's
 *     `contextual_prefix`. Boosts recall on queries that match the
 *     document's external metadata (entity name, document type) when
 *     those tokens don't appear in the OCR text.
 *
 * BM25 indexing has NO dedicated stage — `ai_vectors.search_vector`
 * is a GENERATED STORED column over `contextual_prefix || ' ' || content`
 * populated automatically by Postgres on every INSERT. Since we store
 * the semantic header INSIDE `contextual_prefix`, BM25 also benefits
 * from the metadata signal.
 *
 * Error model:
 *   - chunker failures are data errors → surface to the caller.
 *   - enrichment failures downgrade to an empty prefix per chunk.
 *   - embedding failures throw → the caller retries the whole source.
 *   - upsert failures throw → caller retries.
 *   - zero-inserted-with-chunks-produced → `console.warn` so ops notice
 *     a doc ingested with no vectors (was silent before).
 */

export interface VectorizeSourceInput {
  sourceType: AiVectorSourceType;
  sourceId: string;
  /**
   * Pre-joined markdown of the source content. `null`, `undefined` or
   * an empty string signal the metadata-only path (Excel / CSV). Only
   * supported for `sourceType === "documents"`; memories always carry
   * content.
   */
  content?: string | null;
  metadata: AiVectorMetadata;
  /**
   * Tenant scope. Both `teamId` and `organizationId` are NULL together
   * for global sources (currently only `sourceType === "skills"`); both
   * are set for every other source kind. The DB-level CHECK constraint
   * `ai_vectors_scope_consistency` enforces the (both-or-neither)
   * invariant — a typo here surfaces as a PG `23514` at insert time.
   */
  teamId: string | null;
  organizationId: string | null;
  /**
   * Optional user scope. NULL for team-shared sources (documents,
   * skills, team memories). Set for user-owned sources (user memories,
   * user context). Powers the `(team_id, user_id)` partial index for
   * fast prefiltering before HNSW.
   */
  userId?: string | null;
}

export interface VectorizeSourceResult {
  chunksProduced: number;
  chunksEnriched: number;
  rowsInserted: number;
  rowsDropped: number;
  /** True when the metadata-only branch ran (Excel/CSV). */
  metadataOnly: boolean;
}

/**
 * Type guard narrowing `metadata` to `DocumentVectorMetadata` based on the
 * `sourceType` discriminator. The `metadata` arg is intentionally unused
 * at runtime — the guard is purely a type-level assertion so downstream
 * code can read document-specific fields (file_name, entities, …) without
 * a cast.
 */
const isDocumentMetadata = (
  sourceType: AiVectorSourceType,
  _metadata: AiVectorMetadata,
): _metadata is DocumentVectorMetadata => sourceType === "documents";

const isMemoryMetadata = (
  sourceType: AiVectorSourceType,
  _metadata: AiVectorMetadata,
): _metadata is MemoryVectorMetadata => sourceType === "memories";

const isSkillMetadata = (
  sourceType: AiVectorSourceType,
  _metadata: AiVectorMetadata,
): _metadata is SkillVectorMetadata => sourceType === "skills";

const isContextMetadata = (
  sourceType: AiVectorSourceType,
  _metadata: AiVectorMetadata,
): _metadata is ContextVectorMetadata => sourceType === "context";

/**
 * Source-aware contextual header injected into every chunk's
 * `contextualPrefix` before embedding. Anthropic Contextual Retrieval
 * reduces retrieval failures by 49% when chunks carry a short
 * "situating" prefix; for memories we synthesise this from the file
 * metadata (path + scope) so the model retrieves the right memory by
 * topic even when the chunk body itself is terse.
 *
 * Tags chosen to be unique and easily greppable in retrieval logs:
 *   `[TEAM_MEMORY] path:vendors/acme.md`
 *   `[USER_MEMORY] path:preferences.md`
 */
const buildMemorySemanticHeader = (metadata: MemoryVectorMetadata): string => {
  const tag = metadata.scope === "team" ? "[TEAM_MEMORY]" : "[USER_MEMORY]";
  return `${tag} path:${metadata.path}`;
};

/**
 * Source-aware contextual header for skills. Same rationale as
 * `buildMemorySemanticHeader`: the per-chunk contextual prefix needs
 * a discriminating tag so retrieval can match a skill by topic even
 * when the chunk body is procedural code or a tight reference table.
 *
 * Tag format chosen to be unique, easily greppable, and aligned with
 * the memory pattern:
 *   `[SKILL:xlsx/SKILL.md] Generate or edit Excel workbooks…`
 *   `[SKILL:xlsx/references/formulas-and-formatting.md] …`
 */
const buildSkillSemanticHeader = (metadata: SkillVectorMetadata): string =>
  `[SKILL:${metadata.skill_name}/${metadata.skill_file}] ${metadata.skill_description}`;

/**
 * Source-aware contextual header for context files. Symmetric with the
 * memory tags so retrieval logs and embedding-space neighbours stay
 * legible at a glance — the chatbot can reach for the right context
 * file by topic even when the chunk body itself is procedural or
 * terse.
 *
 *   `[TEAM_CONTEXT] file:vendor-pricing-2026.pdf`
 *   `[USER_CONTEXT] file:my-preferences.md`
 */
const buildContextSemanticHeader = (
  metadata: ContextVectorMetadata,
): string => {
  const tag = metadata.scope === "team" ? "[TEAM_CONTEXT]" : "[USER_CONTEXT]";
  return `${tag} file:${metadata.filename}`;
};

/**
 * Dispatcher for the source-aware semantic header injected into every
 * chunk's contextual prefix before embedding. Returns `null` for
 * source kinds that intentionally skip the header.
 *
 * Each branch narrows `metadata` via the corresponding type guard
 * (`isDocumentMetadata` / `isMemoryMetadata` / `isSkillMetadata`) so
 * the source-specific builders see a properly-typed payload without a
 * runtime cast. Adding a new source kind = add one type guard above
 * + one branch here.
 */
const buildSourceSemanticHeader = (
  sourceType: AiVectorSourceType,
  metadata: AiVectorMetadata,
): string | null => {
  if (isDocumentMetadata(sourceType, metadata))
    return buildSemanticHeader(metadata);
  if (isMemoryMetadata(sourceType, metadata))
    return buildMemorySemanticHeader(metadata);
  if (isSkillMetadata(sourceType, metadata))
    return buildSkillSemanticHeader(metadata);
  if (isContextMetadata(sourceType, metadata))
    return buildContextSemanticHeader(metadata);
  return null;
};

/**
 * Metadata-only branch: one synthetic chunk built from the document's
 * classifiers + summary + entities, embedded directly and upserted.
 * Skips contextual enrichment (pointless — the text is already a
 * structured summary, the LLM cannot add situating context).
 */
const runMetadataOnly = async (
  input: VectorizeSourceInput,
  metadata: DocumentVectorMetadata,
): Promise<VectorizeSourceResult> => {
  const text = buildMetadataOnlyText(metadata);
  const [embedding] = await embedBatch([text]);

  const syntheticChunk: EnrichedChunk = {
    index: 0,
    totalChunks: 1,
    content: text,
    contextualPrefix: "",
  };

  const flaggedMetadata: DocumentVectorMetadata = {
    ...metadata,
    is_metadata_only: true,
  };

  const result = await upsertVectors({
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    teamId: input.teamId,
    organizationId: input.organizationId,
    metadata: flaggedMetadata,
    chunks: [{ chunk: syntheticChunk, embedding: embedding ?? [] }],
  });

  if (result.rowsInserted === 0) {
    console.warn(
      `[vectorize] metadata-only source produced zero rows (sourceType=${input.sourceType}, sourceId=${input.sourceId}) — embedding likely failed`,
    );
  }

  return {
    chunksProduced: 1,
    chunksEnriched: 0,
    rowsInserted: result.rowsInserted,
    rowsDropped: result.rowsDropped,
    metadataOnly: true,
  };
};

/**
 * Run a source's vectorisation as ONE `vectorize` trace (the N contextual-
 * enrichment LLM calls + the embeddings nested under it), grouped under a
 * per-source session (`{sourceType}:{sourceId}`). For documents this is
 * `documents:{documentId}` — the same key `runPreExtract` uses — so OCR +
 * pre-extraction + vectorisation all share one Sessions-view timeline + cost.
 */
export const vectorizeSource = (
  input: VectorizeSourceInput,
): Promise<VectorizeSourceResult> =>
  withPipelineTrace(
    "vectorize",
    `${input.sourceType}:${input.sourceId}`,
    {
      metadata: { sourceType: input.sourceType, sourceId: input.sourceId },
      tags: [
        "process:vectorize",
        ...(input.teamId !== null ? [`team:${input.teamId}`] : []),
      ],
    },
    () => vectorizeSourceImpl(input),
  );

const vectorizeSourceImpl = async (
  input: VectorizeSourceInput,
): Promise<VectorizeSourceResult> => {
  const {
    sourceType,
    sourceId,
    content,
    metadata,
    teamId,
    organizationId,
    userId = null,
  } = input;

  // Metadata-only branch — documents with no RAG-suitable content.
  // Extractions always carry JSON content so never hit this path.
  const hasContent = typeof content === "string" && content.trim().length > 0;
  if (!hasContent) {
    if (!isDocumentMetadata(sourceType, metadata)) {
      throw new Error(
        `vectorize: empty content is only supported for sourceType="documents" (got "${sourceType}")`,
      );
    }
    return runMetadataOnly(input, metadata);
  }

  // Stage 1 — chunking.
  const chunks = splitMarkdown(content);
  if (chunks.length === 0) {
    // Still upsert so stale rows are cleared for this source.
    const result = await upsertVectors({
      sourceType,
      sourceId,
      teamId,
      organizationId,
      userId,
      metadata,
      chunks: [],
    });
    console.warn(
      `[vectorize] chunker produced zero chunks (sourceType=${sourceType}, sourceId=${sourceId}, contentChars=${content.length}) — stale vectors cleared, no new rows`,
    );
    return {
      chunksProduced: 0,
      chunksEnriched: 0,
      rowsInserted: result.rowsInserted,
      rowsDropped: result.rowsDropped,
      metadataOnly: false,
    };
  }

  // Stage 2 — contextual enrichment (individual-chunk failures soften
  // to an empty prefix; stage-wide failure propagates).
  const enriched = await enrichChunks(content, chunks);
  const enrichedCount = enriched.filter(
    (c) => c.contextualPrefix.length > 0,
  ).length;

  // Stage 2b — inject a source-aware semantic header into each chunk's
  // contextual prefix. Documents get the metadata-derived header
  // (file_name + entities + classification); memories get a
  // `[TEAM_MEMORY]` / `[USER_MEMORY] path:…` tag; skills get a
  // `[SKILL:name/file] description` tag so the chatbot can retrieve
  // the right skill by topic even when chunks are procedural code.
  // Extractions skip the header (their JSON content already carries
  // classifiers). See `buildSourceSemanticHeader` for the dispatch.
  const semanticHeader = buildSourceSemanticHeader(sourceType, metadata);

  const enrichedWithHeader: EnrichedChunk[] = semanticHeader
    ? enriched.map((c) => ({
        ...c,
        contextualPrefix:
          c.contextualPrefix.length > 0
            ? `${semanticHeader}\n${c.contextualPrefix}`
            : semanticHeader,
      }))
    : enriched;

  // Stage 3 — batch embed on "prefix + blank line + content". Empty
  // prefixes fall through as "\n\n<content>" which Qwen3 handles fine.
  const embedInputs = enrichedWithHeader.map((c) =>
    c.contextualPrefix.length > 0
      ? `${c.contextualPrefix}\n\n${c.content}`
      : c.content,
  );
  const embeddings = await embedBatch(embedInputs);

  // Stage 4 — upsert transaction.
  const vectorized = enrichedWithHeader.map((chunk, i) => ({
    chunk,
    embedding: embeddings[i] ?? [],
  }));

  const result = await upsertVectors({
    sourceType,
    sourceId,
    teamId,
    organizationId,
    userId,
    metadata,
    chunks: vectorized,
  });

  if (result.rowsInserted === 0 && chunks.length > 0) {
    console.warn(
      `[vectorize] zero rows inserted despite ${chunks.length} chunks produced (sourceType=${sourceType}, sourceId=${sourceId}, rowsDropped=${result.rowsDropped}) — check embedding pipeline`,
    );
  }

  return {
    chunksProduced: chunks.length,
    chunksEnriched: enrichedCount,
    rowsInserted: result.rowsInserted,
    rowsDropped: result.rowsDropped,
    metadataOnly: false,
  };
};
