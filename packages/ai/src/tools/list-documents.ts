import { documentStatusEnum } from "@fretik/shared/db/schema";
import { searchDocuments } from "@fretik/shared/services/documents/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — paginated search over the team's documents.
 *
 * Thin wrapper around `searchDocuments` in `@fretik/shared`. The same
 * shared service is used by the workflow engine's `document` SaaS node
 * (`search` operation) and any future API handler — all three callers
 * share filter semantics so there is only one place to fix a bug or
 * tweak the query.
 *
 * Filters are now fully dynamic: instead of a hardcoded `documentType`
 * enum, the tool accepts a generic `customFilters` list of
 * `{ fieldKey, value }` pairs. The model can discover available keys
 * via `describeObjectType("document")` (or by inspecting field values
 * returned here) and use them to refine searches. Universal filters
 * (label, entity) remain typed.
 */

export const createListDocumentsTool = () =>
  tool({
    description: [
      "List documents for the current team with optional filters and pagination.",
      "",
      "Use this when the user asks for a listing of documents (by type, folder, status, name, label, linked organization, or any custom field) or needs document IDs to feed into another tool (getDocumentContent, getExtractionData, …).",
      "",
      "Filters:",
      "- search: substring match on the original filename (case-insensitive).",
      "- folderId: restrict to a single folder.",
      "- status: processing status ('ready' for usable docs).",
      "- labelIds: any-of match on the team's labels.",
      "- entityIds: any-of match on linked organizations (record ids the document mentions).",
      "- customFilters: equality on the team's configured dynamic fields. Each entry is `{ fieldKey, value }`. Field keys (`document_type`, `category`, `invoice_number`, …) come from the team's field definitions and are visible on each returned document's `fieldValues` map. AND semantics across entries.",
      "",
      "Pagination: `limit` defaults to 20, max 50. Pass the returned `nextOffset` on `hasMore: true` to fetch the next page.",
      "",
      "Returns id, filename, status, folder, fieldValues (custom fields), pageCount, entityCount, createdAt. Does NOT include the markdown body — call `getDocumentContent` for that.",
    ].join("\n"),
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe("Optional case-insensitive substring of the filename"),
      folderId: z
        .string()
        .uuid()
        .optional()
        .describe("Restrict results to a single folder id"),
      status: z
        .enum(documentStatusEnum.enumValues)
        .optional()
        .describe("Processing status — usually 'ready' for usable documents"),
      labelIds: z
        .array(z.string().uuid())
        .optional()
        .describe("Filter to documents tagged with any of these label ids"),
      entityIds: z
        .array(z.string().uuid())
        .optional()
        .describe(
          "Filter to documents that mention any of these organization record ids",
        ),
      customFilters: z
        .array(
          z.object({
            fieldKey: z
              .string()
              .min(1)
              .max(60)
              .describe(
                "Slug of a configured field definition (e.g. 'document_type', 'category')",
              ),
            value: z
              .union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.string()),
                z.array(z.number()),
              ])
              .describe(
                "Value to match. Scalar (string / number / boolean) for an exact match. Array for OR semantics on enum filters (e.g. document_type IN ('invoice','contract')).",
              ),
          }),
        )
        .optional()
        .describe(
          "Per-field equality filters on the team's configured dynamic fields.",
        ),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    execute: async (
      {
        search,
        folderId,
        status,
        labelIds,
        entityIds,
        customFilters,
        limit,
        offset,
      },
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
          folderId,
          status,
          labelIds,
          entityIds,
          customFilters,
          limit: effectiveLimit,
          offset: effectiveOffset,
        });
      } catch (err) {
        return {
          error: `listDocuments failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.LIST_DOCUMENTS_ERROR,
        };
      }

      const payload = {
        documents: result.documents.map((d) => ({
          id: d.id,
          filename: d.originalFilename,
          status: d.status,
          folder: d.folder,
          pageCount: d.pageCount,
          entityCount: d.entityCount,
          fieldValues: d.fieldValues,
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
