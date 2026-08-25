import { ontologyStatusEnum } from "@fretik/shared/db/schema";
import { listCollectionRecords } from "@fretik/shared/services/collection-records/retrieve";
import { resolveCollectionId } from "@fretik/shared/services/collections/resolve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — browse a type's records without writing SQL.
 *
 * The no-SQL companion to `querySql` over the typed tables: full-text search +
 * status filter + pagination over one collection's records, team-scoped.
 * Prefer `querySql` for aggregates, joins, or precise field filters; use this
 * for a quick "show me the <type> records" or to review AI suggestions
 * (`status: 'suggested'`). Drill into one with `getRecord`.
 */
export const createListRecordsTool = () =>
  tool({
    description: [
      "List a type's records (team-scoped), newest first, with full-text search, status filter, and pagination.",
      "",
      "Use for a quick browse of a collection's records, or to review AI-extracted records pending confirmation (`status: 'suggested'`). For counts, aggregates, joins, or exact field filters, write `querySql` against the type's `data.coll_<collectionId>` table instead.",
      "",
      "- collectionKey: the collection slug (from <team_collections>).",
      "- search: full-text over the record label + text fields.",
      "- status: 'confirmed' (default), 'suggested' (AI, unreviewed), or 'rejected'.",
      "- limit defaults to 25 (max 50); pass the returned nextOffset on hasMore.",
      "",
      "Returns id, label, status, data (the record's fields), createdAt.",
    ].join("\n"),
    inputSchema: z.object({
      collectionKey: z
        .string()
        .min(1)
        .max(60)
        .describe("Collection slug (e.g. 'company', 'pricing')."),
      search: z
        .string()
        .optional()
        .describe("Full-text search over the record label + text fields."),
      status: z
        .enum(ontologyStatusEnum.enumValues)
        .optional()
        .describe(
          "Trust filter: 'confirmed' (default), 'suggested' (AI, unreviewed), 'rejected'.",
        ),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    execute: async (
      { collectionKey, search, status, limit, offset },
      options,
    ) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      const effectiveLimit = limit ?? 25;
      const effectiveOffset = offset ?? 0;

      let collectionId: string | null;
      try {
        collectionId = await resolveCollectionId({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          key: collectionKey,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `listRecords failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!collectionId) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_NOT_FOUND,
          `No collection '${collectionKey}' for this team.`,
          "Check the available type keys in <team_collections>.",
        );
      }

      let result: Awaited<ReturnType<typeof listCollectionRecords>>;
      try {
        result = await listCollectionRecords({
          teamId: ctx.teamId,
          collectionId,
          status,
          search,
          // The row offset, not a page number. `nextOffset` below advances by
          // however many rows came back, which lands between page boundaries
          // as soon as one page is short — `floor(offset / limit)` then snapped
          // BACK to the boundary and re-served rows the agent had already seen.
          offset: effectiveOffset,
          limit: effectiveLimit,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `listRecords failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const returned = effectiveOffset + result.data.length;
      const hasMore = returned < result.count;
      const payload = {
        records: result.data.map((r) => ({
          id: r.id,
          label: r.label,
          status: r.status,
          data: r.data,
          createdAt: r.createdAt.toISOString(),
        })),
        pagination: {
          total: result.count,
          limit: effectiveLimit,
          offset: effectiveOffset,
          hasMore,
          nextOffset: hasMore ? returned : null,
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
