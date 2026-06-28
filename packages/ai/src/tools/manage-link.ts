import type { EventActor } from "@fretik/shared/services/domain-events/emit";
import { resolveLinkType } from "@fretik/shared/services/link-types/match";
import { createLink } from "@fretik/shared/services/links/create";
import { invalidateLink } from "@fretik/shared/services/links/invalidate";
import { resolveDocumentRecordId } from "@fretik/shared/services/object-records/resolve-document-record";
import { getObjectRecord } from "@fretik/shared/services/object-records/retrieve";
import { assertCanWriteRecord } from "@fretik/shared/services/object-sharing/write-access";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — connect or disconnect two records over a relation.
 * `link` resolves (or creates) the relation by key, scoped to the from-record's
 * type; `unlink` invalidates an existing edge. Both journal a `domain_event`.
 *
 * Uploaded files are objects too: pass `fromDocumentId` / `toDocumentId` (a real
 * `documents.id`, e.g. from listDocuments) and the edge is made to that file's
 * `document_record` — the agent never resolves the mirror itself.
 */
export const createManageLinkTool = () =>
  tool({
    description: [
      "Connect or disconnect two object records over a relation.",
      "",
      "- link: relationKey + a from end + a to end. Resolves the relation by key (creates it if new) and adds the edge.",
      "- unlink: linkId (from getObject's links).",
      "",
      "Each end is a record id (fromRecordId / toRecordId) OR an uploaded file id (fromDocumentId / toDocumentId — links to the file's document record).",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["link", "unlink"]),
      relationKey: z
        .string()
        .max(60)
        .optional()
        .describe("Relation slug, e.g. 'works_for'. Required for link."),
      fromRecordId: z.string().optional().describe("Source record. For link."),
      toRecordId: z.string().optional().describe("Target record. For link."),
      fromDocumentId: z
        .string()
        .optional()
        .describe("Source = this uploaded file's document record. For link."),
      toDocumentId: z
        .string()
        .optional()
        .describe("Target = this uploaded file's document record. For link."),
      linkId: z.string().optional().describe("Edge id. Required for unlink."),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const actor: EventActor = {
        actorType: "agent",
        actorUserId: ctx.userId ?? null,
        conversationId: ctx.conversationId ?? null,
      };

      try {
        if (input.action === "unlink") {
          if (!input.linkId) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "unlink requires linkId.",
            );
          }
          const link = await invalidateLink({ id: input.linkId, actor });
          return { ok: true, unlinked: link.id };
        }

        const fromRecordId = await resolveEnd(
          ctx.teamId,
          input.fromRecordId,
          input.fromDocumentId,
        );
        const toRecordId = await resolveEnd(
          ctx.teamId,
          input.toRecordId,
          input.toDocumentId,
        );
        if (!input.relationKey || !fromRecordId || !toRecordId) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            "link requires relationKey, a from end (fromRecordId or fromDocumentId), and a to end (toRecordId or toDocumentId).",
          );
        }

        // Owner team or a write grant/share on the record gaining the edge.
        await assertCanWriteRecord({
          recordId: fromRecordId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        const fromRecord = await getObjectRecord({ id: fromRecordId });
        const { linkTypeId } = await resolveLinkType({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          rawKey: input.relationKey,
          fromObjectTypeId: fromRecord.objectTypeId,
        });
        const link = await createLink({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          linkTypeId,
          fromRecordId,
          toRecordId,
          actor,
        });
        return { ok: true, linkId: link.id };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `manageLink ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

/**
 * Resolve one end of a link to a record id: a direct record id, or an uploaded
 * file's id mapped to its `document_record` mirror. Returns undefined when
 * neither is given; throws (caught upstream) when a file has no mirror yet.
 */
const resolveEnd = async (
  teamId: string,
  recordId: string | undefined,
  documentId: string | undefined,
): Promise<string | undefined> => {
  if (recordId) return recordId;
  if (!documentId) return undefined;
  const mirrorId = await resolveDocumentRecordId({ documentId, teamId });
  if (!mirrorId) {
    throw new Error(
      `No document record for file '${documentId}' — it may still be processing.`,
    );
  }
  return mirrorId;
};
