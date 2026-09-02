import { formatBulkRowError } from "../../lib/db-bulk";

/** Longest reason kept. Past this it stops informing and starts costing. */
const MAX_REASON_CHARS = 400;

/**
 * The one readable line a failed approval keeps — stored in `executionError`,
 * shown on the card, and handed to the agent as its tool result.
 *
 * The trimming is the point. A write that fails deep in Drizzle throws a
 * `DrizzleQueryError` whose own message is `Failed query: INSERT INTO … (…)`
 * followed by every column and every bound parameter — the incident of
 * 2026-08-28 produced 4 714 characters of it, and the sentence that actually
 * explained the failure (`cannot insert a non-DEFAULT value into column
 * "depense_totale"`) was buried inside. Three reasons not to keep the dump:
 * the user is shown it, the agent pays for it by the token, and the parameters
 * are the records themselves — the user's own data, copied into an error
 * column and into a model's context.
 *
 * So the driver's `cause` wins when there is one: it is the database's actual
 * complaint, one sentence, no payload.
 */
export const approvalFailureReason = (error: unknown): string => {
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : null;
  const reason = (cause ?? formatBulkRowError(error)).trim();
  const collapsed = reason.replace(/\s+/g, " ");
  if (collapsed.length === 0) return "Execution failed";
  return collapsed.length > MAX_REASON_CHARS
    ? `${collapsed.slice(0, MAX_REASON_CHARS - 1)}…`
    : collapsed;
};
