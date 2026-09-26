import { redis } from "../../lib/redis";

/**
 * Who is running code in a conversation's sandbox RIGHT NOW — the parent turn,
 * or one of its sub-agents.
 *
 * `/sandbox/exec` cannot tell them apart from the request: the sandbox holds
 * ONE credential per turn (`ensureSandboxTurnSetup` mints it for the turn, not
 * for the agent), so a `records.bulk_update` from a sub-agent's cell arrives
 * with exactly the JWT the parent's would. What does separate them is time.
 * Every cell of a conversation — parent's or sub-agent's — runs under the same
 * per-conversation exec mutex (`e2b:exec:{conversationId}`), so while a
 * sub-agent's cell holds it, every sandbox call of that conversation IS that
 * cell's. The caller sets this marker inside the mutex, before the cell, and
 * clears it in a `finally` after; the dispatcher reads it and refuses what a
 * sub-agent may not do.
 *
 * Why a sub-agent may not write: its tool calls never reach the conversation's
 * stream, so a write it made is one the user never saw, and an approval it
 * opened has no card to answer it — and, since a conversation holds one
 * pending approval at a time, it would block every later one. Writes stay with
 * the parent, whose calls the user sees.
 *
 * The TTL outlives the longest cell the mutex admits (5.5 min hold) with
 * margin, so a process that dies mid-cell cannot leave the parent locked out
 * for longer than one cell would have taken.
 */

const EXEC_SCOPE_TTL_S = 400;

const execScopeKey = (conversationId: string): string =>
  `sandbox:exec-scope:${conversationId}`;

/** Run `fn` with this conversation's sandbox calls marked as a sub-agent's. */
export const withSubAgentExecScope = async <T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  await redis.set(
    execScopeKey(conversationId),
    "sub-agent",
    "EX",
    EXEC_SCOPE_TTL_S,
  );
  try {
    return await fn();
  } finally {
    await redis.del(execScopeKey(conversationId)).catch((err: unknown) => {
      // The TTL is the net: the parent is refused writes for at most one
      // cell's length, never indefinitely.
      console.warn(
        `[sandbox/exec-scope] failed to clear the sub-agent marker for ${conversationId}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }
};

/**
 * Whether the cell currently running in this conversation's sandbox belongs
 * to a sub-agent. A Redis failure answers `false`: the parent's writes are the
 * common case, and the sub-agent's own tool set carries no write tool — this
 * marker guards the one door that tool set cannot close, the Python SDK.
 */
export const isSubAgentExecScope = async (
  conversationId: string,
): Promise<boolean> => {
  try {
    return (await redis.get(execScopeKey(conversationId))) === "sub-agent";
  } catch (err) {
    console.warn(
      `[sandbox/exec-scope] could not read the sub-agent marker for ${conversationId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
};
