import { and, desc, eq } from "drizzle-orm";
import db from "../../db";
import { aiMessages } from "../../db/schema";

/**
 * Replace the `output` of a single `tool-python` part in an existing
 * persisted assistant message, identified by its `toolCallId`. Used by
 * the external-apps approval handlers to substitute the placeholder
 * `{ status: "approval_pending", ... }` payload with the final
 * `approval_granted` / `approval_rejected` outcome BEFORE the next
 * chatbot turn runs — that way the agent sees the actual result in
 * its history and doesn't need to re-call `python`.
 *
 * Scans the last 20 assistant messages of the conversation (in reverse
 * chronological order) because a python tool call is always in a recent
 * assistant turn — the agent stopped via `pythonAwaitingApproval`
 * immediately after producing it.
 *
 * Throws `MessagePartNotFoundError` if no message in that window
 * contains a `tool-python` part with the given `toolCallId`. Callers
 * that tolerate this case (recovery / second-write scenarios) should
 * call `findToolCallIdForApproval` first to gate the update.
 */
export class MessagePartNotFoundError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly toolCallId: string,
  ) {
    super(
      `No tool-python part with toolCallId=${toolCallId} found in last 20 assistant messages of conversation ${conversationId}`,
    );
    this.name = "MessagePartNotFoundError";
  }
}

const PYTHON_PART_TYPE = "tool-python";

export const updateToolPartOutputByToolCallId = async (params: {
  conversationId: string;
  toolCallId: string;
  newOutput: unknown;
}): Promise<void> => {
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
    let mutated = false;
    const nextParts = parts.map((part) => {
      // Defensive narrowing — UIMessage parts are loosely typed (we
      // can't `instanceof` a structural type).
      if (
        typeof part !== "object" ||
        part === null ||
        (part as { type?: unknown }).type !== PYTHON_PART_TYPE
      ) {
        return part;
      }
      const callId = (part as { toolCallId?: unknown }).toolCallId;
      if (callId !== params.toolCallId) return part;
      mutated = true;
      return {
        ...part,
        state: "output-available",
        output: params.newOutput,
      } as typeof part;
    });

    if (mutated) {
      await db
        .update(aiMessages)
        .set({ parts: nextParts })
        .where(eq(aiMessages.id, row.id));
      return;
    }
  }

  throw new MessagePartNotFoundError(params.conversationId, params.toolCallId);
};
