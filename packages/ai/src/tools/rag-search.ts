import { AI_VECTOR_SOURCE_TYPES } from "@fretik/shared/db/schema";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  maybePersistLargeOutput,
  RAG_THRESHOLD_CHARS,
} from "../lib/persisted-output";
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
 * transport mode, …) is already reachable via the dedicated domain
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
      "Unified semantic search across all team knowledge: documents, memories, skills, context.",
      "",
      "Use this FIRST for any content-related question — 'what does doc X say', 'how do I generate Excel files', 'what did we agree about carrier Y', 'find shipments for container Z'. The model never reaches knowledge directly; it goes through this tool.",
      "",
      "- `question` must be natural language. Put ids in `filters.sourceIds`, never in the question.",
      "- `filters.sourceTypes` (optional): documents, memories, skills, context. Defaults to all sources when omitted. Example: `{ filters: { sourceTypes: ['memories'] } }` to scan only the memory store before a write.",
      '- `filters.sourceIds` narrows to pre-selected rows. Example: `{ question: "demurrage clause", filters: { sourceTypes: ["documents"], sourceIds: ["7d3a1b8c-...","9c2e..."] } }`. Chain with `listDocuments` / `listEntities` for structural filters (type, date, entity, transport mode) — this tool does not accept structural filters directly.',
      "- Always cite each answer with the chunk's `sourceType`, `sourceId`, and key metadata (file name, memory path, skill name).",
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
            .array(z.enum(AI_VECTOR_SOURCE_TYPES))
            .optional()
            .describe(
              "Restrict to specific source types. Defaults to all when omitted.",
            ),
          sourceIds: z
            .array(z.uuid())
            .max(100)
            .optional()
            .describe(
              "Narrow to specific row UUIDs pre-selected via listDocuments / listExtractions / listEntities. Max 100 ids per call.",
            ),
        })
        .optional(),
    }),
    execute: async ({ question, filters }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      let result: Awaited<ReturnType<typeof searchRAG>>;
      try {
        result = await searchRAG({
          query: question,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          filters,
          topK: TOP_K,
          debug: RAG_DEBUG,
        });
      } catch (err) {
        return {
          error: `RAG search failed: ${err instanceof Error ? err.message : String(err)}`,
          code: "RAG_ERROR",
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

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        RAG_THRESHOLD_CHARS,
      );
    },
  });
