import { and, eq, gte, inArray } from "drizzle-orm";
import db from "../../db";
import { chatSuggestions } from "../../db/schema";

/**
 * What this reader accepted or rejected lately, as labels.
 *
 * Fed back into the generator's context so a suggestion someone dismissed does
 * not return the next morning — the single cheapest thing that separates a
 * feature people keep from one they learn to ignore.
 *
 * `used` rows are listed too, and for the same reason: an offer that was
 * already taken is done, and repeating it wastes a slot.
 *
 * Superseded rows are NOT listed. Nobody rejected those; the context simply
 * moved on before anyone looked, and suppressing them would quietly erase a
 * suggestion that was never seen.
 */
const WINDOW_DAYS = 14;

export interface ResolvedSuggestionLabel {
  label: string;
  status: "used" | "dismissed";
}

export const listRecentSuggestionLabels = async (params: {
  userId: string;
  teamId: string;
  days?: number;
}): Promise<ResolvedSuggestionLabel[]> => {
  const days = params.days ?? WINDOW_DAYS;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      label: chatSuggestions.label,
      status: chatSuggestions.status,
    })
    .from(chatSuggestions)
    .where(
      and(
        eq(chatSuggestions.userId, params.userId),
        eq(chatSuggestions.teamId, params.teamId),
        inArray(chatSuggestions.status, ["used", "dismissed"]),
        gte(chatSuggestions.resolvedAt, since),
      ),
    );

  return rows.flatMap((row) =>
    row.status === "used" || row.status === "dismissed"
      ? [{ label: row.label, status: row.status }]
      : [],
  );
};
