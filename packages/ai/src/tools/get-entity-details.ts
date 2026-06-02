import { getEntity } from "@fretik/shared/services/entities/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — read a single entity by id including its
 * full list of linked documents.
 *
 * Thin wrapper around the shared `getEntity` service with
 * `includeLinkedDocuments: true`. The default call path (used by the
 * API handler and the drive UI) leaves that flag off so payloads stay
 * small — the chatbot opts into the extra join because the model
 * usually needs the linked document ids to answer "what's tied to
 * entity X" questions.
 */

export const createGetEntityDetailsTool = () =>
  tool({
    description: [
      "Read a single entity by id with its full list of linked documents.",
      "",
      "Use this after `listEntities` (or after the user gave you an entity id) to inspect the entity's enrichment fields (website, address, country, …) and the documents attached to it with their role.",
      "",
      "Returns the entity row + `documentCount` + `documentEntities` (each with role, source, confidence, the linked document id, filename, mime type, status, createdAt).",
    ].join("\n"),
    inputSchema: z.object({
      entityId: z.uuid().describe("UUID of the entity to read"),
    }),
    execute: async ({ entityId }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      let entity: Awaited<ReturnType<typeof getEntity>>;
      try {
        entity = await getEntity({
          id: entityId,
          teamId: ctx.teamId,
          includeLinkedDocuments: true,
        });
      } catch (err) {
        return {
          error: `getEntityDetails failed: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.GET_ENTITY_DETAILS_ERROR,
        };
      }

      return maybePersistLargeOutput(
        entity,
        ctx.conversationId,
        toolCallId,
        DOMAIN_TOOL_THRESHOLD_CHARS,
      );
    },
  });
