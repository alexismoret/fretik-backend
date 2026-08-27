import {
  isPageVarRef,
  type PageFieldDescriptor,
  type PageValue,
} from "../../../schemas/pages";
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
 * grouped or indexed the way a collection can. The documented path for real
 * volume is unchanged — a workflow syncs the data into a collection, and the
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
  /**
   * Whether this app must be asked one question at a time, from the connection
   * pin or the provider key alone — no DB, no connection resolution, because
   * this is called to SCHEDULE the datasets, before any of them has run.
   *
   * `undefined` means "no constraint we know of here". A per-connection
   * override that only the row carries is therefore invisible to this and falls
   * through to the lock, which is correct but slower — the fast path only knows
   * what the provider declares.
   */
  serialKey?: (dataset: {
    connectionId?: string;
    providerKey?: string;
  }) => string | undefined;
  execute: (input: {
    teamId: string;
    /** The viewer; null on the anonymous route (unreachable behind the
     * publish gate, guarded anyway). */
    userId: string | null;
    /** The page, so a viewer's stored choice of account can be honoured. */
    pageId?: string;
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
  "External app datasets are not enabled in this process. Query the connected app in this conversation and store what the page needs, or model the data as a collection.";

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

/** Rows sampled to infer the shape. Enough to see a key that is null in the
 *  first row, cheap enough to run on every read. */
const INFER_SAMPLE_ROWS = 20;
/** A third party with more columns than this is not a page's data source. */
const INFER_MAX_FIELDS = 40;

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `givenName` / `given_name` / `given-name` → `Given name`. */
const humanise = (key: string): string => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.length === 0
    ? key
    : words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * The display dictionary an external dataset never shipped.
 *
 * An `collections` dataset comes back with `fields`, and that one descriptor is
 * what makes a column render as a labelled, formatted value instead of a raw
 * key. External datasets shipped rows and nothing else, so every page over a
 * connected app had to invent its own headers — which is why they show the
 * provider's own key (`givenName`, `dateTimeCreated`) to a person.
 *
 * Inference is deliberately timid. The LABEL is the gap this closes and it is
 * always safe; the TYPE is only claimed when every value observed for a key
 * agrees, and anything mixed, nested or empty comes back `unknown` rather than
 * as a guess. A wrong `type` is worse than none: it sends a page through a
 * formatter the value cannot survive.
 */
export const inferExternalFields = (
  rows: readonly PageValue[],
): PageFieldDescriptor[] => {
  const seen = new Map<string, Set<string>>();
  for (const row of rows.slice(0, INFER_SAMPLE_ROWS)) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    for (const [key, value] of Object.entries(row)) {
      if (!seen.has(key) && seen.size >= INFER_MAX_FIELDS) continue;
      const kinds = seen.get(key) ?? new Set<string>();
      seen.set(key, kinds);
      // A null says nothing about the type and must not make it `unknown` —
      // a column that is empty in row one and a number in row two is a number.
      if (value === null || value === undefined) continue;
      if (typeof value === "number") kinds.add("number");
      else if (typeof value === "boolean") kinds.add("boolean");
      else if (typeof value === "string")
        kinds.add(
          ISO_DATETIME.test(value)
            ? "datetime"
            : CALENDAR_DATE.test(value)
              ? "date"
              : "text",
        );
      else kinds.add("unknown");
    }
  }

  const fields: PageFieldDescriptor[] = [];
  for (const [key, kinds] of seen) {
    const [only] = [...kinds];
    const inferred = kinds.size === 1 && only !== undefined ? only : "unknown";
    fields.push({
      key,
      label: humanise(key),
      type: inferred === "datetime" ? "date" : inferred,
      // Nothing here is stored, so nothing can be written back or ordered by
      // the server — a third party's answer is a snapshot, not a table.
      sortable: false,
      writable: false,
      ...(inferred === "datetime" ? { hasTime: true } : {}),
    });
  }
  return fields;
};

export const externalSource: PageDataSource = {
  kind: "external",
  serialKey: (dataset) =>
    dataset.kind === "external"
      ? executor?.serialKey?.({
          ...(dataset.connectionId !== undefined
            ? { connectionId: dataset.connectionId }
            : {}),
          ...(dataset.providerKey !== undefined
            ? { providerKey: dataset.providerKey }
            : {}),
        })
      : undefined,
  resolve: async (dataset, { teamId, userId, pageId, state, fresh }) => {
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
      ...(pageId !== undefined ? { pageId } : {}),
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
      const fields = inferExternalFields(result.rows);
      return {
        status: "ok",
        rows: result.rows,
        truncated: result.truncated,
        ...(fields.length > 0 ? { fields } : {}),
      };
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
