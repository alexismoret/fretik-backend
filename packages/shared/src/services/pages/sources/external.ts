import { isPageVarRef, type PageValue } from "../../../schemas/pages";
import type { PageDataSource } from "./types";
import { toPageValue } from "./values";

/**
 * A live read from a connected app — the executor behind it is REGISTERED, not
 * imported, so `services/pages` keeps knowing nothing about MCP transports or
 * provider registries, and every consumer of the page registry that never
 * installs one (a bare test, a future worker) gets a refusal instead of a
 * dependency.
 *
 * The six preconditions this seam once listed are now either met or explicitly
 * assumed:
 *
 * 1. Uniform query verb — the executor dispatches a descriptor/manifest READ
 *    action by name (`exec/page-query.ts`), the same names the agent already
 *    reads in the app's SKILL.
 * 2. Execution outside a conversation — the executor is context-free: no
 *    `ExecContext`, no approval gate, identity is `{ teamId, userId }`.
 * 3. Per-connection budget — a Redis counter bounds upstream calls per minute;
 *    the cache absorbs the normal load.
 * 4. Opt-in per connection — ASSUMED rather than modelled: an `active`
 *    connection whose action is not `blocked` may feed a page. A dedicated
 *    "usable in pages" flag stays a future hardening.
 * 5. Crowd-disabling guard — the page path NEVER writes `connection.status`;
 *    an upstream failure costs the dataset's block, nothing else.
 * 6. No external data on `/p/<token>` — the publish gate refuses it
 *    (`pagePublishError`), unchanged.
 *
 * WHAT THIS IS NOT FOR: large volumes. A third party cannot be filtered,
 * grouped or indexed the way an object type can. The documented path for real
 * volume is unchanged — a workflow syncs the data into an object type, and the
 * page queries THAT, in SQL, over indexed columns. This source is for small,
 * live reads whose value is their freshness.
 */

/**
 * What an implementation must provide. `args` arrive as LITERALS — the source
 * resolves bindings before the call, so the executor's cache key and the
 * request it sends are the same values, and the executor stays evaluable
 * without a page in hand.
 */
export interface ExternalPageQueryExecutor {
  execute: (input: {
    teamId: string;
    /** The viewer; null on the anonymous route (unreachable behind the
     * publish gate, guarded anyway). */
    userId: string | null;
    /** Pinned connection, when the dataset names one. */
    connectionId?: string;
    /** Provider to resolve per viewer (their own connection, else the team's). */
    providerKey?: string;
    operation: string;
    args: Record<string, PageValue>;
    resultPath?: string;
    /** Reuse window for the upstream answer. Executor applies the default. */
    cacheTtlSeconds?: number;
    /** Bypass the cached answer (refresh button); still repopulates. */
    fresh?: boolean;
  }) => Promise<
    | { status: "ok"; rows: PageValue[]; truncated: boolean }
    | { status: "needs_connection"; providerKey: string; displayName?: string }
    | { status: "error"; message: string }
  >;
}

let executor: ExternalPageQueryExecutor | undefined;

/**
 * Install the implementation. Until something calls this, the source refuses —
 * which is the whole point of the seam: the refusal is the default, and turning
 * it on is one explicit registration at process boot rather than a scattering
 * of edits.
 */
export const registerExternalPageQueryExecutor = (
  implementation: ExternalPageQueryExecutor,
): void => {
  executor = implementation;
};

/** Test hook: restore the not-enabled default between cases. */
export const resetExternalPageQueryExecutor = (): void => {
  executor = undefined;
};

const NOT_ENABLED =
  "External app datasets are not enabled in this process. Query the connected app in this conversation and store what the page needs, or model the data as an object type.";

/**
 * Resolve `{ "$": … }` bindings anywhere inside the args against page STATE
 * only. Datasets run in parallel waves, so reading `data.*` here would race
 * whatever it names — the sanitizer warns on it, and the scope simply does not
 * carry it. A binding that evaluates to nothing drops its key (the "empty
 * means all" convention filters already follow); one that fails to evaluate
 * fails the dataset, because a request with a silently-wrong argument is worse
 * than no request.
 */
const resolveArgValue = (
  value: PageValue,
  state: Record<string, PageValue>,
):
  { ok: true; value: PageValue | undefined } | { ok: false; error: string } => {
  if (isPageVarRef(value)) {
    const resolved = state[value.var];
    if (resolved === undefined) return { ok: true, value: undefined };
    return { ok: true, value: toPageValue(resolved) };
  }
  if (Array.isArray(value)) {
    const entries: PageValue[] = [];
    for (const entry of value) {
      const resolved = resolveArgValue(entry, state);
      if (!resolved.ok) return resolved;
      if (resolved.value !== undefined) entries.push(resolved.value);
    }
    return { ok: true, value: entries };
  }
  if (typeof value === "object" && value !== null) {
    const mapped: Record<string, PageValue> = {};
    for (const [key, inner] of Object.entries(value)) {
      const resolved = resolveArgValue(inner, state);
      if (!resolved.ok) return resolved;
      if (resolved.value !== undefined) mapped[key] = resolved.value;
    }
    return { ok: true, value: mapped };
  }
  return { ok: true, value };
};

export const resolveExternalArgs = (
  args: Record<string, PageValue>,
  state: Record<string, PageValue>,
):
  | { ok: true; args: Record<string, PageValue> }
  | { ok: false; error: string } => {
  const resolved: Record<string, PageValue> = {};
  for (const [key, value] of Object.entries(args)) {
    const entry = resolveArgValue(value, state);
    if (!entry.ok) {
      return { ok: false, error: `argument "${key}": ${entry.error}` };
    }
    if (entry.value !== undefined) resolved[key] = entry.value;
  }
  return { ok: true, args: resolved };
};

export const externalSource: PageDataSource = {
  kind: "external",
  resolve: async (dataset, { teamId, userId, state, fresh }) => {
    if (!executor) return { status: "error", message: NOT_ENABLED };
    if (!dataset.operation || (!dataset.connectionId && !dataset.providerKey)) {
      return {
        status: "error",
        message:
          "an external dataset needs operation and providerKey (or a pinned connectionId), all from the stored definition",
      };
    }
    const resolvedArgs = resolveExternalArgs(dataset.args ?? {}, state);
    if (!resolvedArgs.ok) {
      return { status: "error", message: resolvedArgs.error };
    }
    const result = await executor.execute({
      teamId,
      userId,
      operation: dataset.operation,
      args: resolvedArgs.args,
      ...(dataset.connectionId !== undefined
        ? { connectionId: dataset.connectionId }
        : {}),
      ...(dataset.providerKey !== undefined
        ? { providerKey: dataset.providerKey }
        : {}),
      ...(dataset.resultPath !== undefined
        ? { resultPath: dataset.resultPath }
        : {}),
      ...(dataset.cacheTtlSeconds !== undefined
        ? { cacheTtlSeconds: dataset.cacheTtlSeconds }
        : {}),
      ...(fresh !== undefined ? { fresh } : {}),
    });
    if (result.status === "ok") {
      return { status: "ok", rows: result.rows, truncated: result.truncated };
    }
    if (result.status === "needs_connection") {
      return {
        status: "needs_connection",
        providerKey: result.providerKey,
        ...(result.displayName !== undefined
          ? { displayName: result.displayName }
          : {}),
      };
    }
    return { status: "error", message: result.message };
  },
};
