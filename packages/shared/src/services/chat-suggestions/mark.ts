import { and, eq } from "drizzle-orm";
import db from "../../db";
import { chatSuggestions } from "../../db/schema";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * Record what the reader did with one suggestion.
 *
 * The `userId` predicate is the privacy boundary, not a convenience: without
 * it any signed-in member could resolve a colleague's suggestion by id, and
 * the ids are handed to the browser. Deleting it reddens the integration test.
 *
 * `status = 'active'` in the WHERE makes this idempotent in the only way that
 * matters — a double click cannot turn a `used` row into a `dismissed` one,
 * and a row from a superseded batch cannot be resurrected by a late click.
 */
export const markChatSuggestion = async (params: {
  id: string;
  userId: string;
  teamId: string;
  status: "used" | "dismissed";
}): Promise<void> => {
  const updated = await db
    .update(chatSuggestions)
    .set({ status: params.status, resolvedAt: new Date() })
    .where(
      and(
        eq(chatSuggestions.id, params.id),
        eq(chatSuggestions.userId, params.userId),
        eq(chatSuggestions.teamId, params.teamId),
        eq(chatSuggestions.status, "active"),
      ),
    )
    .returning({ id: chatSuggestions.id });

  if (updated.length === 0) {
    return throwHttpError(404, notFound("Suggestion not found"));
  }
};
