import { redis } from "../../lib/redis";

/**
 * Out-of-band "a write plan is awaiting approval" signal, bridging the
 * sandbox-exec gate (API process) and the `python` tool (AI process).
 *
 * Why this exists — the approval CARD on the frontend is keyed on the
 * `python` tool returning `{ status: "approval_pending", approvalId }`, and
 * the tool only emits that when `fretik_apps.run_plan(...)` (or any other
 * gated sandbox call) raises `ApprovalPending` **uncaught**. If the agent
 * wraps the call in `try/except` (or otherwise swallows the exception), the
 * row is still created server-side but the UI never learns about it — the
 * user sees no modal and the write silently hangs.
 *
 * `runApprovalGate` (`../approvals/gate.ts`) is the single source of truth
 * for "a pending approval was returned this run" across every sandbox-driven
 * kind (`external_app_plan`, `record_write`, MCP reads/writes), so it stamps
 * this Redis key whenever it returns `approval_pending`. The `python` tool
 * consumes (read-once) the key right after the SAME cell finishes and
 * surfaces the approval regardless of how the agent handled the exception.
 *
 * Lifetime — this signal is NOT the approval. The approval row lives in the
 * DB indefinitely (human-in-the-loop; a user may approve days later) and the
 * rendered card re-fetches the live row from the API. This key only bridges
 * the few seconds between "gate created/found the row" and "python cell
 * returns", bounded by the 5-min sandbox cap. It is set during the sandbox
 * call and deleted on read in the same cell, so the TTL is just a backstop
 * for a cell that dies before consuming it — short on purpose, so a
 * never-consumed signal can't resurface a stale card on a later cell.
 */

const TTL_SECONDS = 600;

const key = (conversationId: string): string =>
  `e2b:pending-approval:${conversationId}`;

/** Stamp that a pending approval was just created/returned for this run. */
export const markSandboxApprovalPending = async (
  conversationId: string,
  approvalId: string,
): Promise<void> => {
  await redis.set(key(conversationId), approvalId, "EX", TTL_SECONDS);
};

/** Read-and-clear the pending-approval signal for a conversation. */
export const consumeSandboxApprovalPending = async (
  conversationId: string,
): Promise<string | undefined> => {
  const k = key(conversationId);
  const approvalId = await redis.get(k);
  if (approvalId === null) return undefined;
  await redis.del(k);
  return approvalId;
};
