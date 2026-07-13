import { getObjectRecord } from "@fretik/shared/services/object-records/retrieve";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  DOMAIN_TOOL_THRESHOLD_CHARS,
  maybePersistLargeOutput,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — one record by id, team-scoped, with its data and its
 * linked records (both directions) grouped by relation. Use after `listObjects`
 * or a `querySql` that returned a record id, when the user wants the full
 * record + what it is connected to.
 */
export const createGetObjectTool = () =>
  tool({
    description: [
      "Fetch one object record by id (team-scoped): its fields plus the records it links to and from, grouped by relation.",
      "",
      "Use after `listObjects` or a `querySql` that surfaced a record id, when the user wants the full record and its connections (e.g. a company and the documents that mention it). Returns id, label, status, data, and outgoing/incoming links (relation key + the record on the other end).",
    ].join("\n"),
    inputSchema: z.object({
      id: z
        .string()
        .uuid()
        .describe("Record id from listObjects or a querySql result."),
    }),
    execute: async ({ id }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      let record: Awaited<ReturnType<typeof getObjectRecord>>;
      try {
        record = await getObjectRecord({ id });
      } catch {
        // getObjectRecord throws 404 when absent — surface as a clean not-found.
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `No record '${id}' found.`,
        );
      }

      // Team scope: never reveal a record from another team.
      if (record.teamId !== ctx.teamId) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `No record '${id}' found.`,
        );
      }

      const payload = {
        id: record.id,
        label: record.label,
        status: record.status,
        data: record.data,
        createdAt: record.createdAt.toISOString(),
        outgoingLinks: record.outgoingLinks.flatMap((l) =>
          l.linkType && l.toRecord
            ? [
                {
                  relation: l.linkType.key,
                  to: { id: l.toRecord.id, label: l.toRecord.label },
                },
              ]
            : [],
        ),
        incomingLinks: record.incomingLinks.flatMap((l) =>
          l.linkType && l.fromRecord
            ? [
                {
                  relation: l.linkType.key,
                  from: { id: l.fromRecord.id, label: l.fromRecord.label },
                },
              ]
            : [],
        ),
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        DOMAIN_TOOL_THRESHOLD_CHARS,
      );
    },
  });
