import { and, desc, eq } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";

/**
 * Locate the `tool-python` part in this conversation's recent assistant
 * messages whose output is `{ status: "approval_pending", approvalId }`
 * matching the given approvalId. Used by the external-apps approval
 * handlers to find which tool call needs its output mutated after the
 * user's decision.
 *
 * Returns `undefined` when no match is found — either the message has
 * scrolled past the 20-message lookback window, or the part has
 * already been mutated to its final state (idempotent recovery path).
 */
const PYTHON_PART_TYPE = "tool-python";

export const findToolCallIdForApproval = async (params: {
  conversationId: string;
  approvalId: string;
}): Promise<{ messageId: string; toolCallId: string } | undefined> => {
  const rows = await db
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, params.conversationId),
        eq(aiMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(aiMessages.createdAt))
    .limit(20);

  for (const row of rows) {
    const parts = row.parts;
    for (const part of parts) {
      if (
        typeof part !== "object" ||
        part === null ||
        (part as { type?: unknown }).type !== PYTHON_PART_TYPE
      ) {
        continue;
      }
      const output = (part as { output?: unknown }).output;
      if (output === null || typeof output !== "object") continue;
      const status = (output as { status?: unknown }).status;
      const approvalId = (output as { approvalId?: unknown }).approvalId;
      if (status === "approval_pending" && approvalId === params.approvalId) {
        const toolCallId = (part as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId !== "string") continue;
        return { messageId: row.id, toolCallId };
      }
    }
  }
  return undefined;
};
