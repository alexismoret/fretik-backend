import { documentStatusEnum, documentTypeEnum } from "@fretik/shared/db/schema";
import { searchDocuments } from "@fretik/shared/services/documents/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";

/**
 * Domain tool (deferred) — paginated search over the team's documents.
 *
 * Thin wrapper around `searchDocuments` in `@fretik/shared`. The same
 * shared service is used by the workflow engine's `document` SaaS node
 * (`search` operation) and any future API handler — all three callers
 * share filter semantics so there is only one place to fix a bug or
 * tweak the query.
 *
 * Uses the tighter `DOMAIN_TOOL_THRESHOLD_CHARS` (16K) — domain tools
 * return JSON metadata lists; tighter cap nudges the agent to paginate
 * / refine filters instead of digesting a huge dump inline.
 */

export const createListDocumentsTool = () =>
  tool({
    description: [
      "List documents for the current team with optional filters and pagination.",
      "",
      "Use this when the user asks for a listing of documents (by type, folder, status, name) or needs document IDs to feed into another tool (getDocumentContent, getExtractionData, …).",
      "",
      "Filters:",
      "- search: substring match on the original filename (case-insensitive).",
      "- documentType: exact match on the pre-extracted type (invoice, contract, …).",
      "- folderId: restrict to a single folder.",
      "- status: processing status ('ready' for usable docs).",
      "",
      "Pagination: `limit` defaults to 20, max 50. Pass the returned `nextOffset` on `hasMore: true` to fetch the next page.",
      "",
      "Returns id, filename, documentType, status, folder, createdAt, pageCount, entityCount. Does NOT include the markdown body — call `getDocumentContent` for that.",
    ].join("\n"),
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring of the filename"),
      documentType: z
        .enum(documentTypeEnum.enumValues)
        .optional()
        .describe("Exact document type from the pre-extraction catalogue"),
      folderId: z
        .string()
        .uuid()
        .optional()
        .describe("Restrict results to a single folder id"),
      status: z
        .enum(documentStatusEnum.enumValues)
        .optional()
        .describe("Processing status — usually 'ready' for usable documents"),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    execute: async (
      { search, documentType, folderId, status, limit, offset },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      const effectiveLimit = limit ?? 20;
      const effectiveOffset = offset ?? 0;

      let result: Awaited<ReturnType<typeof searchDocuments>>;
      try {
        result = await searchDocuments({
          teamId: ctx.teamId,
          search,
          documentType,
          folderId,
          status,
          limit: effectiveLimit,
          offset: effectiveOffset,
        });
      } catch (err) {
        return {
          error: `listDocuments failed: ${err instanceof Error ? err.message : String(err)}`,
          code: "LIST_DOCUMENTS_ERROR",
        };
      }

      const payload = {
        documents: result.documents.map((d) => ({
          id: d.id,
          filename: d.originalFilename,
          status: d.status,
          documentType: d.documentType,
          folder: d.folder,
          pageCount: d.pageCount,
          entityCount: d.entityCount,
          createdAt: d.createdAt.toISOString(),
        })),
        pagination: {
          limit: result.limit,
          offset: result.offset,
          hasMore: result.hasMore,
          nextOffset: result.hasMore
            ? result.offset + result.documents.length
            : null,
        },
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        DOMAIN_TOOL_THRESHOLD_CHARS,
      );
    },
  });
