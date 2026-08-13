import { findBulkOperation } from "@fretik/shared/services/bulk-operations/find";
import type { ConversationTaskContinuation } from "./continuation-registry";

/**
 * What the agent is told about a finished import, and what to do about it.
 *
 * Deliberately counters-only. The load is committed and the agent has no
 * per-row context left to correlate — repeating rows here would put megabytes
 * back into the very context the streamed path exists to protect.
 */
const IMPORT_DOCTRINE =
  "Report the counters to the user and point them at the object type to check the data — an import is worth verifying, and they are the one who knows what the source was supposed to contain. When rows failed, the errors above give the row number and the reason: state the pattern (one bad column, one wrong format) rather than listing the rows, and offer to re-import just those. Do NOT re-run the whole import to fix a few rows.";

export const buildBulkOperationContinuation: ConversationTaskContinuation = {
  buildLine: async (task) => {
    const operation = await findBulkOperation(task.ref);
    if (!operation) return null;

    const progress = operation.progress;
    const failed = progress?.failed ?? 0;
    const outcome =
      operation.status === "done"
        ? `${(progress?.succeeded ?? 0).toString()} of ${operation.totalItems.toString()} rows written${failed > 0 ? `, ${failed.toString()} failed` : ""}`
        : `ended as ${operation.status}${operation.error ? `: ${operation.error}` : ""}`;

    // The first few failures, verbatim — a "3 rows failed" with no reason is
    // something the agent can only relay, not act on.
    const sample = (progress?.errors ?? [])
      .slice(0, 3)
      .map((e) => `row ${e.index.toString()}: ${e.error}`)
      .join("; ");
    const more =
      (progress?.errorCount ?? 0) > 3
        ? ` (+${((progress?.errorCount ?? 0) - 3).toString()} more)`
        : "";

    return {
      line: [
        `Import into "${operation.params.typeKey}" ${outcome}.`,
        ...(sample ? [`First errors — ${sample}${more}.`] : []),
      ].join(" "),
      actingUserId: operation.userId,
      tags: [],
    };
  },
  doctrine: () => [IMPORT_DOCTRINE],
};
