import { entityStatusEnum, entityTypeEnum } from "@fretik/shared/db/schema";
import { listEntities } from "@fretik/shared/services/entities/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";

/**
 * Domain tool (deferred) — paginated listing of the team's entities
 * (carriers, clients, other companies).
 *
 * Thin wrapper around the shared `listEntities` service, same service
 * already used by the API handler. Filter semantics are owned there.
 */

export const createListEntitiesTool = () =>
  tool({
    description: [
      "List entities (carriers, clients, other companies) for the current team with optional filters and pagination.",
      "",
      "Use this when the user wants to browse entities, find an entity id to feed into `getEntityDetails`, or filter by type/status.",
      "",
      "Filters:",
      "- search: substring match on name, normalized name, or aliases (case-insensitive).",
      "- type: carrier, client, or other.",
      "- status: confirmed (validated), suggested (AI-created, pending review), rejected.",
      "",
      "Pagination: `limit` defaults to 20, max 50. Pass the returned `nextOffset` on `hasMore: true` to fetch the next page.",
      "",
      "Returns id, name, type, status, country, website, enrichment status, and document count. Does NOT include the full list of linked documents — call `getEntityDetails` for that.",
    ].join("\n"),
    inputSchema: z.object({
      search: z
        .string()
        .optional()
        .describe(
          "Case-insensitive substring of name, normalized name, or aliases",
        ),
      type: z
        .enum(entityTypeEnum.enumValues)
        .optional()
        .describe("Restrict to carriers, clients, or other"),
      status: z
        .enum(entityStatusEnum.enumValues)
        .optional()
        .describe(
          "confirmed (validated), suggested (AI-created), rejected. Defaults to all",
        ),
      limit: z.number().int().min(1).max(50).optional(),
      offset: z.number().int().nonnegative().optional(),
    }),
    execute: async ({ search, type, status, limit, offset }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      const effectiveLimit = limit ?? 20;
      const effectiveOffset = offset ?? 0;

      let result: Awaited<ReturnType<typeof listEntities>>;
      try {
        result = await listEntities({
          teamId: ctx.teamId,
          search,
          type,
          status,
          limit: effectiveLimit,
          offset: effectiveOffset,
        });
      } catch (err) {
        return {
          error: `listEntities failed: ${err instanceof Error ? err.message : String(err)}`,
          code: "LIST_ENTITIES_ERROR",
        };
      }

      const hasMore = effectiveOffset + result.data.length < result.count;
      const payload = {
        entities: result.data.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          status: e.status,
          country: e.country,
          website: e.website,
          documentCount: e.documentCount,
          enrichmentStatus: e.enrichmentStatus,
          aliases: e.aliases,
          createdAt: e.createdAt.toISOString(),
        })),
        pagination: {
          total: result.count,
          limit: effectiveLimit,
          offset: effectiveOffset,
          hasMore,
          nextOffset: hasMore ? effectiveOffset + result.data.length : null,
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
