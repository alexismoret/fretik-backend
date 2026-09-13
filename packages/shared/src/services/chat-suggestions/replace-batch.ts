import { and, eq } from "drizzle-orm";
import db from "../../db";
import { chatSuggestions, type ChatSuggestionKind } from "../../db/schema";
import type { SuggestionBatch } from "./get-active-batch";

/**
 * Swap the reader's active suggestions for a freshly generated batch.
 *
 * One transaction, because the two halves are one fact: rows left `active`
 * beside a new batch would show two generations at once, and a supersede that
 * commits without its replacement would blank the card until the next refresh.
 *
 * The previous rows are superseded, never deleted — what was offered is half
 * of what "this suggestion was ignored" means, and the anti-repetition read
 * needs the other half (`used` / `dismissed`) to stay beside it.
 */
export interface SuggestionToStore {
  kind: ChatSuggestionKind;
  label: string;
  prompt: string;
  reason: string;
  sourceRefs: string[];
}

export const replaceSuggestionBatch = async (params: {
  organizationId: string;
  teamId: string;
  userId: string;
  inputHash: string;
  modelKey: string;
  items: SuggestionToStore[];
}): Promise<SuggestionBatch> => {
  const batchId = Bun.randomUUIDv7();
  const now = new Date();

  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(chatSuggestions)
      .set({ status: "superseded", resolvedAt: now })
      .where(
        and(
          eq(chatSuggestions.userId, params.userId),
          eq(chatSuggestions.teamId, params.teamId),
          eq(chatSuggestions.status, "active"),
        ),
      );

    if (params.items.length === 0) return [];

    return tx
      .insert(chatSuggestions)
      .values(
        params.items.map((item) => ({
          organizationId: params.organizationId,
          teamId: params.teamId,
          userId: params.userId,
          batchId,
          kind: item.kind,
          label: item.label,
          prompt: item.prompt,
          reason: item.reason,
          sourceRefs: item.sourceRefs,
          inputHash: params.inputHash,
          modelKey: params.modelKey,
        })),
      )
      .returning();
  });

  return {
    batchId,
    inputHash: params.inputHash,
    modelKey: params.modelKey,
    createdAt: inserted[0]?.createdAt ?? now,
    items: inserted.map((row) => ({
      id: row.id,
      kind: row.kind,
      label: row.label,
      prompt: row.prompt,
      reason: row.reason,
    })),
  };
};
