import {
  AI_VECTOR_SOURCE_TYPES,
  type AiVectorSourceType,
} from "@fretik/shared/db/schema";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  maybePersistLargeOutput,
  RAG_THRESHOLD_CHARS,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { searchRAG } from "../services/search";

/**
 * Semantic RAG search tool.
 *
 * Thin wrapper over the Phase 7c `searchRAG` orchestrator. The heavy
 * lifting (multi-query reformulation, hybrid HNSW+BM25 retrieval,
 * weighted RRF fusion, Cohere rerank) lives in `services/search/`.
 * This tool only owns the Zod input contract, the persisted-output
 * wrapping, and the trimming of the service-level result to the
 * minimum payload the agent actually needs.
 *
 * Filter surface is intentionally tight: `sourceTypes` + `sourceIds`.
 * Every other structural filter (document type, date, entity,
 * category, …) is already reachable via the dedicated domain
 * tools and the agent pre-selects ids there, then passes them here.
 * Keeps filter semantics in one place and keeps the RAG tool surface
 * from ballooning with every new source kind.
 *
 * RAG uses the centralised `RAG_THRESHOLD_CHARS` (48K) instead of the
 * default 32K — RAG is the model's primary content-fetching tool, so
 * persistence here means "wasted turn to fetch back what should have
 * been inline". 48K keeps the typical top-20 chunk result inline.
 */

/**
 * Dev-mode flag. When set, `searchRAG` populates `debugScores` on the
 * service result — the tool does NOT forward them to the agent (they
 * exist only for the Phase 9.5 frontend debug panel). Zero prod cost.
 */
const RAG_DEBUG = process.env.AI_RAG_DEBUG === "true";

const TOP_K = 20;

export const createRagSearchTool = () =>
  tool({
    description: [
      "Semantic search across team knowledge: documents, memories, skills, context, past episodes, object records, and workflows. Returns up to 20 most-relevant text chunks with source metadata.",
      "",
      'THE first move whenever the answer lives in the text of a document, memory, skill, or context file — "what does this contract say about penalties", "summarize the latest audit report", "do we have a process for onboarding". This works even when you already know exactly WHICH document: pass its id in `filters.sourceIds` and ask — cheaper and faster than downloading the file. Reach for `downloadDriveDocument` ONLY when you need the original bytes (parsing, vision, template reuse), never to answer a content question.',
      "",
      "- `question` must be natural language. Put ids in `filters.sourceIds`, never in the question.",
      "- `filters.sourceTypes` (optional): defaults to all. `workflows` answers whether something that already does this exists — search it before proposing to build one, since the user asks for the outcome, not for a workflow.",
      "- `filters.sourceIds` (optional): narrow to specific row UUIDs (e.g. from `listDocuments`) — the way to search INSIDE one or a few known documents. This tool takes no structural filters (type, date, folder) directly; pre-select ids with `listDocuments` first.",
    ].join("\n"),
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          "Natural language question. No ids, no SQL, no raw keywords.",
        ),
      filters: z
        .object({
          sourceTypes: z
            .array(z.string())
            .optional()
            .describe(
              `Restrict to specific source types: ${AI_VECTOR_SOURCE_TYPES.join(", ")}. Defaults to all when omitted.`,
            ),
          sourceIds: z
            .array(z.uuid())
            .max(100)
            .optional()
            .describe(
              "Narrow to specific row UUIDs pre-selected via listDocuments. Max 100 ids per call.",
            ),
        })
        .optional(),
    }),
    execute: async ({ question, filters }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      // Permissive sourceTypes: the model sometimes requests a type that
      // isn't vector-indexed (structured rows are reached via querySql).
      // Drop unknown values and steer the model, instead of failing the
      // whole call on a schema enum.
      const isSourceType = (t: string): t is AiVectorSourceType =>
        AI_VECTOR_SOURCE_TYPES.some((v) => v === t);
      const requestedTypes = filters?.sourceTypes ?? [];
      const validTypes: AiVectorSourceType[] =
        requestedTypes.filter(isSourceType);
      const droppedTypes = requestedTypes.filter((t) => !isSourceType(t));
      const effectiveFilters:
        | { sourceTypes?: AiVectorSourceType[]; sourceIds?: string[] }
        | undefined = filters
        ? {
            sourceIds: filters.sourceIds,
            sourceTypes: validTypes.length > 0 ? validTypes : undefined,
          }
        : undefined;
      const sourceTypeNotice =
        droppedTypes.length > 0
          ? `Ignored unsupported sourceType(s): ${droppedTypes.join(", ")}. Supported: ${AI_VECTOR_SOURCE_TYPES.join(", ")}.`
          : undefined;

      let result: Awaited<ReturnType<typeof searchRAG>>;
      try {
        result = await searchRAG({
          query: question,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          filters: effectiveFilters,
          topK: TOP_K,
          debug: RAG_DEBUG,
        });
      } catch (err) {
        return {
          error: `RAG search failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.RAG_ERROR,
        };
      }

      // The agent only gets what it needs to read the content and
      // cite it. `queryVariants` and `candidatesExamined` exist for
      // observability and never make it into the agent's context.
      //
      // `debugScores` + `filtersApplied` are forwarded ONLY when the
      // dev flag is on, for the Phase 9.5 frontend debug panel. In
      // prod they're omitted entirely — zero extra payload, zero
      // extra model-context cost.
      const payload: {
        results: Array<{
          content: string;
          sourceType: (typeof AI_VECTOR_SOURCE_TYPES)[number];
          sourceId: string;
          chunkIndex: number;
          totalChunks: number;
          metadata: (typeof result.results)[number]["metadata"];
          rerankScore: number | null;
        }>;
        filtersApplied?: typeof result.filtersApplied;
        debugScores?: typeof result.debugScores;
        notice?: string;
      } = {
        results: result.results.map((r) => ({
          // Contextual prefix is merged into the content — same
          // shape the embedding and BM25 indices see at ingest time,
          // so the agent reads the chunk with its situating preamble
          // already stitched in.
          content:
            r.contextualPrefix.length > 0
              ? `${r.contextualPrefix}\n\n${r.content}`
              : r.content,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          chunkIndex: r.chunkIndex,
          totalChunks: r.totalChunks,
          metadata: r.metadata,
          rerankScore: r.rerankScore,
        })),
      };

      if (RAG_DEBUG) {
        payload.filtersApplied = result.filtersApplied;
        payload.debugScores = result.debugScores;
      }
      if (sourceTypeNotice) payload.notice = sourceTypeNotice;

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        RAG_THRESHOLD_CHARS,
      );
    },
  });
