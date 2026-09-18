import { eq } from "drizzle-orm";
import db from "../../../db";
import {
  type ToolApprovalOpResult,
  type ToolApprovalRequest,
  toolApprovalRequests,
} from "../../../db/schema";
import { isRecord } from "../../../external-apps/json-access";
import { purgeExecutedPayloads } from "../../../external-apps/purge-payloads";
import { markFailedApproval } from "../../approvals/claim";
import { markConsumed } from "../../approvals/complete";

/**
 * How an executed plan's row is closed — `consumed` or `failed`.
 *
 * `consumed` is not just a terminal state, it is a REPLAY CACHE: the gate
 * looks an approval up by `lookupHash` and answers a matching `consumed` row
 * with its stored result, without executing anything (`approvals/gate.ts`).
 * That is what makes a re-run of the agent's own code idempotent.
 *
 * Caching a plan in which nothing was written turns that into a trap. Not
 * every argument reaches the hash — `excludeFromHash` drops volatile prose
 * outright — so an agent that fixes what it sent and re-issues the SAME call
 * can match the old row and be handed the OLD failure, verbatim, with
 * nothing executed. Measured in production on 2026-09-16: an upload rejected
 * for one empty payload, corrected, re-sent, and answered with the identical
 * error — after which the agent spent four minutes and fifteen tool calls
 * inventing workarounds against a perfectly healthy server.
 *
 * So: a plan that wrote nothing closes `failed`, which the hash lookup skips,
 * and the corrected call opens a fresh request.
 */

/**
 * True when an op left nothing behind it.
 *
 * Two shapes, because a bulk action keeps its own per-item contract INSIDE a
 * successful op: `upload_files` returns one row per file, and the executor
 * wraps a non-record return as `{ok: true, data: {value: [...rows]}}`. An op
 * whose every row failed wrote exactly as much as an op that threw — reading
 * only the outer `ok` would cache it as a success.
 *
 * Conservative in the direction that matters: one `ok` row, an empty list, or
 * a shape this does not recognise all count as "something happened".
 */
export const opWroteNothing = (result: ToolApprovalOpResult): boolean => {
  if (!result.ok) return true;
  const rows = result.data.value;
  if (!Array.isArray(rows) || rows.length === 0) return false;
  return rows.every((row) => isRecord(row) && row.ok === false);
};

/** Cap on `execution_error`: it is rendered on the approval card, and it is
 * the only trace of the attempt the agent-facing tool output keeps. */
const FAILURE_SUMMARY_MAX_CHARS = 1000;

/**
 * Why the plan wrote nothing, in the agent's words rather than a status.
 *
 * `indeterminate` carries the op indices whose outcome is genuinely UNKNOWN —
 * a transfer that ran out of wall clock may have been accepted by the far end
 * before the deadline fired. Saying so is the difference between a safe retry
 * and a duplicate landing on a partner's server.
 */
export const planFailureSummary = (
  results: ToolApprovalOpResult[],
  indeterminate: ReadonlySet<number> = new Set(),
): string => {
  const reasons: string[] = [];
  for (const [index, result] of results.entries()) {
    for (const reason of opReasons(result)) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    if (indeterminate.has(index)) {
      const warning =
        "The outcome of this operation is UNKNOWN — the server may have accepted some bytes before the deadline. Check the destination before re-sending.";
      if (!reasons.includes(warning)) reasons.push(warning);
    }
  }
  if (reasons.length === 0) return "The plan wrote nothing.";
  const joined = reasons.join(" · ");
  return joined.length <= FAILURE_SUMMARY_MAX_CHARS
    ? joined
    : `${joined.slice(0, FAILURE_SUMMARY_MAX_CHARS - 1)}…`;
};

/** Every distinct reason an op carries — its own, or its rows'. */
const opReasons = (result: ToolApprovalOpResult): string[] => {
  if (!result.ok) return [result.error];
  const rows = result.data.value;
  if (!Array.isArray(rows)) return [];
  const reasons: string[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row.ok !== false) continue;
    reasons.push(typeof row.error === "string" ? row.error : "failed");
  }
  return reasons;
};

/**
 * Close an executed plan's row.
 *
 * `failed` ONLY when nothing succeeded at any level. A half-succeeded plan
 * stays `consumed`: re-issuing that one is how a file gets written twice,
 * which is precisely what the cache exists to prevent.
 *
 * Residual risk, accepted deliberately: a transfer that timed out may have
 * landed, so a plan of only such ops becomes retryable and a retry can write
 * twice. The alternative — keeping those `consumed` — restores the dead end
 * for the most common transient failure there is, which is strictly worse.
 * It is bounded in chat (a retry needs a NEW approval card) and by
 * `on_conflict="replace"` (idempotent per path); it is NOT bounded for
 * `on_conflict="rename"`, for autonomous runs that auto-grant, or for
 * non-file providers where a timed-out send becomes a duplicate message.
 * `planFailureSummary` names the uncertainty so the agent can check first.
 *
 * `markFailedApproval` leaves `result` untouched — the per-op detail written
 * incrementally by `updatePartialResult` survives for audit.
 */
export const finalizePlanRow = async (
  approvalId: string,
  finalResults: ToolApprovalOpResult[],
  indeterminate: ReadonlySet<number> = new Set(),
): Promise<void> => {
  // `length > 0` guards the vacuous `every`: a zero-op plan wrote nothing
  // because there was nothing to write, which is not a failure.
  const wroteNothing =
    finalResults.length > 0 && finalResults.every(opWroteNothing);
  if (wroteNothing) {
    await markFailedApproval(
      approvalId,
      planFailureSummary(finalResults, indeterminate),
    );
  } else {
    await markConsumed(approvalId, finalResults);
  }
  // Terminal now, so the stored bytes are evidence rather than input. A
  // separate statement on purpose: losing the purge to a crash leaves a
  // fat row, losing the status transition would leave a stuck one.
  await purgeRowPayloads(approvalId);
};

/**
 * Replace an executed row's bulk payloads with `{bytes, sha256}`.
 *
 * Reads the row back rather than taking the caller's copy: `executePlan`
 * holds the approval as it was CLAIMED, and `modify-and-grant` may have
 * rewritten `operations` between the card and the execution.
 */
const purgeRowPayloads = async (approvalId: string): Promise<void> => {
  const row: ToolApprovalRequest | undefined =
    await db.query.toolApprovalRequests.findFirst({
      where: { id: approvalId },
    });
  if (row?.operations == null) return;
  const purged = purgeExecutedPayloads(row.operations);
  if (purged === null) return;
  await db
    .update(toolApprovalRequests)
    .set({ operations: purged })
    .where(eq(toolApprovalRequests.id, approvalId));
};
