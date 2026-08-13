import { and, desc, eq } from "drizzle-orm";
import db, { type Transaction } from "../../db";
import { aiMessages } from "../../db/schema";

/**
 * Replace the `output` of a single tool part in an existing persisted
 * assistant message, identified by its `toolCallId`. Used by the approval
 * handlers to substitute the placeholder `{ status: "approval_pending", ... }`
 * payload with the final `approval_granted` / `approval_rejected` /
 * `answered` outcome BEFORE the next agent turn runs — that way the agent
 * sees the actual result in its history and doesn't re-call the tool. Works
 * for any tool that emits the pause marker (`python`, `proposeRecords`, the
 * workflow `askUserQuestion`) — matched by `toolCallId`, not tool name.
 *
 * Scans the last 20 assistant messages of the conversation (in reverse
 * chronological order) because the paused tool call is always in a recent
 * assistant turn — the agent stopped on the approval marker immediately
 * after producing it.
 *
 * Throws `MessagePartNotFoundError` if no message in that window
 * contains a tool part with the given `toolCallId`. Callers
 * that tolerate this case (recovery / second-write scenarios) should
 * call `findToolCallIdForApproval` first to gate the update.
 */
export class MessagePartNotFoundError extends Error {
  constructor(
    public readonly conversationId: string,
    public readonly toolCallId: string,
  ) {
    super(
      `No tool part with toolCallId=${toolCallId} found in last 20 assistant messages of conversation ${conversationId}`,
    );
    this.name = "MessagePartNotFoundError";
  }
}

export const updateToolPartOutputByToolCallId = async (params: {
  conversationId: string;
  toolCallId: string;
  newOutput: unknown;
  /** Rewrite the history entry with the writes that made it true. */
  tx?: Transaction;
}): Promise<void> => {
  const exec = params.tx ?? db;
  const rows = await exec
    .select()
    .from(aiMessages)
    .where(
      and(
        eq(aiMessages.conversationId, params.conversationId),
        eq(aiMessages.role, "assistant"),
      ),
    )
    .orderBy(desc(aiMessages.seq))
    .limit(20);

  for (const row of rows) {
    const parts = row.parts;
    let mutated = false;
    const nextParts = parts.map((part) => {
      // Defensive narrowing — UIMessage parts are loosely typed (we
      // can't `instanceof` a structural type). Match any tool part by its
      // toolCallId (unique per call), independent of tool name.
      if (typeof part !== "object" || part === null) return part;
      const type = (part as { type?: unknown }).type;
      if (typeof type !== "string" || !type.startsWith("tool-")) return part;
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
      await exec
        .update(aiMessages)
        .set({ parts: nextParts })
        .where(eq(aiMessages.id, row.id));
      return;
    }
  }

  throw new MessagePartNotFoundError(params.conversationId, params.toolCallId);
};
