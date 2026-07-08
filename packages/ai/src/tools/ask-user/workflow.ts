import type { ToolApprovalQuestionPayload } from "@fretik/shared/db/schema";
import { createPendingQuestionApproval } from "@fretik/shared/services/approvals/create-pending-question";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../../agents/shared/runtime-context";
import { TOOL_ERROR_CODES } from "../../lib/tool-error-codes";
import { askUserQuestionSchema } from "./schema";

/**
 * `askUserQuestion` (workflow executor) — the BLOCKING sibling of the chat
 * tool. A run has no live user, so instead of echoing the questions it creates
 * a `question` approval and pauses the run: the orchestrator parks on a wait
 * token, the user answers the structured card, and the answers arrive
 * SUBSTITUTED into this tool's result on resume. Never re-call the tool — the
 * answer replaces `approval_pending` in history.
 *
 * Use for an open decision the playbook can't resolve itself (which option to
 * pursue, ambiguous instruction). For proposing record writes, use the objects
 * SDK (`records.bulk_*`) — those pause the run on a `record_write` approval.
 */
export const createAskUserQuestionWorkflowTool = () =>
  tool({
    description: [
      "Pause the run to ask the user a structured multiple-choice question and wait for their answer.",
      "The run parks until the user answers; the answer arrives substituted into this tool's result. Do NOT re-call the tool afterwards.",
      "Use when a task genuinely needs a human decision the playbook can't make (pick a direction, resolve a real ambiguity). Prefer a sensible default when one exists.",
      "Submit 1 to 4 questions per call. The UI adds an 'Other' free-text option — do not include one. Set multiSelect when answers are not mutually exclusive.",
    ].join("\n"),
    inputSchema: z.object({
      questions: z
        .array(askUserQuestionSchema)
        .min(1)
        .max(4)
        .describe("Questions to ask the user (1 to 4 per call)."),
    }),
    execute: async ({ questions }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId || !ctx.userId) {
        return {
          error:
            "askUserQuestion requires an active workflow conversation with a user.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }

      // Drop `preview` — the question approval payload stores label + description.
      const payload: ToolApprovalQuestionPayload = {
        questions: questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: q.multiSelect,
        })),
      };

      const approval = await createPendingQuestionApproval({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        // No sandbox turn for a tool call — the tool-call id is the correlation.
        turnId: options.toolCallId,
        payload,
      });

      return {
        status: "approval_pending" as const,
        approvalId: approval.id,
        message:
          "⏸ Question raised — the run is paused until the user answers. The answer will arrive in this tool's result; do not re-call.",
      };
    },
  });
