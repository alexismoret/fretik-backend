import type { ExternalAppConnection } from "../../../db/schema";
import { canonicalProviderKey } from "../../../external-apps/canonical-provider-key";
import { getAction, getProvider } from "../../../external-apps/registry";
import { redis } from "../../../lib/redis";
import { PAGE_LIMITS, type PageValue } from "../../../schemas/pages";
import { canonicalHash } from "../../approvals/hash";
import {
  registerExternalPageQueryExecutor,
  type ExternalPageQueryExecutor,
} from "../../pages/sources/external";
import { toPageValue } from "../../pages/sources/values";
import {
  resolveConnectionActionPolicy,
  resolveToolPolicy,
} from "../../tool-policies/resolve";
import { resolvePageConnection } from "../connections/resolve-for-page";
import { isMcpConnection } from "../mcp/connection-kind";
import { normalizeMcpResult } from "../mcp/normalize";
import { getSnapshotForConnection } from "../mcp/snapshot-store";
import { mcpCallTool } from "../mcp/transport";
import { executeReadAction } from "./read-executor";
import { validateActionArgs } from "./validate-args";

/**
 * Walk a plain dot path (`value.items[0].rows`) into an upstream answer.
 * Property and index steps only — a path is DATA, nothing evaluates. Returns
 * undefined the moment a step finds nothing.
 */
const resolveResultPath = (payload: unknown, path: string): unknown => {
  let current: unknown = payload;
  for (const match of path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== "object") return undefined;
    const property = match[1];
    if (property !== undefined) {
      current = Reflect.get(current, property);
    } else if (match[2] !== undefined) {
      current = Array.isArray(current) ? current[Number(match[2])] : undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
};

/**
 * The page-dataset implementation of `ExternalPageQueryExecutor` — a READ over
 * a connected app with no conversation anywhere: no `ExecContext`, no approval
 * gate, identity is `{ teamId, userId }` and the connection is resolved per
 * viewer (their own first, the team's second — `resolvePageConnection`).
 *
 * Policy: only `blocked` refuses. The `approval` level exists to gate an AGENT
 * acting inside a conversation; a page dataset was declared once by its author
 * and the viewer is looking at data a connection they may use already reaches.
 *
 * Three protections stand between a page render and a third party:
 *  - a Redis cache per (connection, operation, args, resultPath) — the normal
 *    render is a cache hit, and personal connections partition it per viewer
 *    by construction (distinct connection ids);
 *  - an upstream budget per connection per minute — a crowd can exhaust the
 *    budget, never the third party's patience;
 *  - a wait a caller will not exceed, and a run budget across all of a page's
 *    external datasets — a slow app costs its widget a message, not the page a
 *    hang.
 *
 * And one invariant: this path NEVER writes `connection.status`. A page view
 * must not be able to flip a team's integration to `error`.
 */

/**
 * How long a CALLER waits for an answer — not how long the call may take.
 *
 * Measured 2026-08-28 in production (Langfuse session `01a03e9b…`): an Akanea
 * WMS read takes 12-15 s (a licence seat is leased per action and its calls
 * cannot overlap), so at the old 10 s every one of a page's five datasets came
 * back `error` — in the app AND in the review harness, which reads the same
 * fixtures. Worse, the answer that arrived at 13 s was thrown away, so the next
 * render started from cold and failed identically. The provider's own client
 * tolerates 60 s; ten was a page-side invention nothing supported.
 *
 * So the wait is 45 s, and the WORK is never abandoned: a call that outlives
 * the wait keeps running and fills the cache when it lands, which turns the
 * first slow render into a warm-up rather than a permanent wall. A caller past
 * this ceiling gets "still working, ask again" instead of the truncated lie
 * that the app failed.
 *
 * Two things bound it from outside and neither is ours to raise here: the MCP
 * transport aborts at 30 s (`mcp/client.ts`), and a registry provider's own
 * client aborts at whatever it declares (Akanea: 60 s). The connection slot's
 * lease must exceed the LONGEST of those, not this — see `read-executor.ts`.
 */
const UPSTREAM_TIMEOUT_MS = 45_000;
/**
 * Below this much remaining run budget, a dataset that has not started does not
 * start: no answer can arrive inside what is left, so the call would take a
 * licence seat and a slot in the per-minute budget to return the same "still
 * working" it returns for free.
 */
const MIN_CALL_MS = 3_000;
/**
 * Upstream calls one connection may make per minute, SHARED by everyone
 * reading through it — which on a team connection means the whole team.
 *
 * That sharing is only survivable because of the cache in front of it: one
 * connection + operation + arguments is ONE upstream call per TTL window
 * however many people are looking, and concurrent misses collapse into a
 * single run. So this bounds DISTINCT questions per minute, not page views.
 *
 * 120 rather than 60: a six-widget page whose viewers hold different filter
 * values produces a few dozen distinct keys in its first minute, and a ceiling
 * a legitimate page can reach is a ceiling that will be hit by a user rather
 * than by an abuser.
 */
const UPSTREAM_BUDGET_PER_MINUTE = 120;
/** Ceiling on the JSON size of one dataset's rows. */
const MAX_RESULT_BYTES = 1_000_000;
const BINARY_OMITTED = "[binary content omitted]";

type PageQueryInput = Parameters<ExternalPageQueryExecutor["execute"]>[0];
type PageQueryResult = Awaited<
  ReturnType<ExternalPageQueryExecutor["execute"]>
>;
type PageQueryRows = { rows: PageValue[]; truncated: boolean };

/**
 * In-flight upstream runs, keyed like the cache — joined even by `fresh`
 * requests: a run under way IS a fresh upstream answer.
 *
 * An entry outlives the caller that started it. A caller whose wait runs out
 * walks away; the run stays here until it lands, so the next reader joins it
 * instead of asking a third party the same question a second time.
 */
const inFlight = new Map<string, Promise<PageQueryResult>>();

/** What a wait that ran out returns instead of an answer. */
const STILL_WORKING = Symbol("still-working");

/**
 * Wait `ms` for `work`, then give up on the WAIT — never on the work.
 * `work` must not reject: it is left running with nobody watching it.
 */
const waitFor = async <T>(
  work: Promise<T>,
  ms: number,
): Promise<T | typeof STILL_WORKING> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<typeof STILL_WORKING>((resolve) => {
    timer = setTimeout(() => {
      resolve(STILL_WORKING);
    }, ms);
  });
  try {
    return await Promise.race([work, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/**
 * What a caller gets when the app is slower than its wait.
 *
 * Deliberately NOT "the app failed": the question is still being asked, the
 * answer will be in the cache, and a page that renders "unavailable" here tells
 * its viewer something false. `retryAfterMs` is what a page waits before asking
 * the same dataset again — long enough that a retry storm cannot form, short
 * enough that a 15 s app fills in while someone is still looking.
 */
const stillWorking = (
  connection: ExternalAppConnection,
  waitedMs: number,
): PageQueryResult => ({
  status: "error",
  message: `"${connection.displayName}" is still working after ${Math.max(Math.round(waitedMs / 1000), 1).toString()}s — its answer is being cached, not lost. Query this dataset again in a few seconds.`,
  retryAfterMs: 5_000,
});

/**
 * What a dataset gets when the render's shared budget ran out before its turn —
 * the app was never asked, so there is nothing in flight to wait for and
 * nothing wrong with the app either.
 */
const notAsked = (connection: ExternalAppConnection): PageQueryResult => ({
  status: "error",
  message: `this page spent its budget waiting on "${connection.displayName}" before reaching this dataset — query it on its own in a few seconds, when the earlier answers are cached.`,
  retryAfterMs: 5_000,
});

/**
 * Replace base64 payloads with a marker anywhere in the answer. A page cannot
 * render them, and one screenshot-returning tool would otherwise blow the row
 * budget with bytes nobody can see.
 */
const stripBinary = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripBinary);
  if (typeof value === "object" && value !== null) {
    const mapped: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      mapped[key] =
        key === "content_base64" ? BINARY_OMITTED : stripBinary(inner);
    }
    return mapped;
  }
  return value;
};

/**
 * Whatever shape the app answered in, hand the page an array of row COLLECTIONS —
 * the one shape a table column or a chart axis can read. Scalars are wrapped
 * under `value` so `item.value` always works.
 */
const asRows = (value: unknown): PageValue[] => {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((entry) => {
      const page = toPageValue(entry);
      return typeof page === "object" && page !== null && !Array.isArray(page)
        ? page
        : { value: page };
    });
  }
  const page = toPageValue(value);
  return typeof page === "object" && page !== null && !Array.isArray(page)
    ? [page]
    : [{ value: page }];
};

const capRows = (rows: PageValue[]): PageQueryRows => {
  let kept =
    rows.length > PAGE_LIMITS.maxRows
      ? rows.slice(0, PAGE_LIMITS.maxRows)
      : rows;
  let truncated = kept.length < rows.length;
  // The byte cap protects the wire and the browser, not the upstream: halve
  // until it fits rather than measuring row by row.
  while (kept.length > 0 && JSON.stringify(kept).length > MAX_RESULT_BYTES) {
    kept = kept.slice(0, Math.ceil(kept.length / 2));
    truncated = true;
  }
  return { rows: kept, truncated };
};

/** One upstream call per minute-window budget, per connection. */
const underBudget = async (connectionId: string): Promise<boolean> => {
  const key = `rl:page-ext:${connectionId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= UPSTREAM_BUDGET_PER_MINUTE;
};

const blockedMessage = (
  operation: string,
  connection: ExternalAppConnection,
): string =>
  `"${operation}" is disabled on connection "${connection.displayName}" by its permission settings — an admin can change that under Settings → Tool permissions`;

/** Call the app over whichever transport the connection speaks. Throws. */
const callUpstream = async (
  connection: ExternalAppConnection,
  operation: string,
  args: Record<string, PageValue>,
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> => {
  if (isMcpConnection(connection)) {
    const snapshot = await getSnapshotForConnection(connection);
    if (snapshot === undefined) {
      return {
        ok: false,
        message: `connection "${connection.displayName}" is still preparing its tools — retry shortly`,
      };
    }
    const action = snapshot.descriptor.actions.find(
      (candidate) => candidate.name === operation,
    );
    if (action === undefined) {
      const reads = snapshot.descriptor.actions
        .filter((candidate) => candidate.kind === "read")
        .map((candidate) => candidate.name)
        .slice(0, 12)
        .join(", ");
      return {
        ok: false,
        message: `unknown operation "${operation}" on ${connection.providerKey} — read operations: ${reads}`,
      };
    }
    if (action.kind !== "read") {
      return {
        ok: false,
        message: `"${operation}" is a write — a page dataset may only read; writes belong to page operations`,
      };
    }
    if (action.mcpToolName === undefined) {
      return {
        ok: false,
        message: `"${operation}" has no MCP tool binding on this connection`,
      };
    }
    const level = resolveToolPolicy({
      kind: "read",
      defaultLevel: action.approvalDefault,
      override: connection.actionPolicies?.[operation],
      autonomy: null,
    });
    if (level === "blocked") {
      return { ok: false, message: blockedMessage(operation, connection) };
    }
    const raw = await mcpCallTool(connection, action.mcpToolName, args);
    return { ok: true, data: normalizeMcpResult(raw) };
  }

  const qualifiedName = `${connection.providerKey}.${operation}`;
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    return {
      ok: false,
      message: `unknown operation "${operation}" on ${connection.providerKey} — the app's skill lists its action names`,
    };
  }
  if (resolved.action.kind !== "read") {
    return {
      ok: false,
      message: `"${operation}" is a write — a page dataset may only read; writes belong to page operations`,
    };
  }
  const level = resolveConnectionActionPolicy({
    action: { name: resolved.action.name, kind: "read" },
    actionPolicies: connection.actionPolicies,
    autonomy: null,
  });
  if (level === "blocked") {
    return { ok: false, message: blockedMessage(operation, connection) };
  }
  let validated: Record<string, unknown>;
  try {
    validated = validateActionArgs(qualifiedName, resolved.action, args);
  } catch (error) {
    return {
      ok: false,
      message: `invalid args for "${operation}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const data = await executeReadAction(resolved, connection, validated);
  return { ok: true, data };
};

/**
 * One upstream question, start to finish, cache write included.
 *
 * NEVER REJECTS, and that is load-bearing: it is left running by a caller whose
 * wait ran out, so a rejection here would surface as an unhandled one with
 * nobody left to catch it.
 */
const runQuery = async (
  input: PageQueryInput,
  connection: ExternalAppConnection,
  cacheKey: string,
  ttlSeconds: number,
): Promise<PageQueryResult> => {
  let underMinuteBudget: boolean;
  try {
    underMinuteBudget = await underBudget(connection.id);
  } catch {
    underMinuteBudget = true;
  }
  if (!underMinuteBudget) {
    return {
      status: "error",
      message: `"${connection.displayName}" hit its per-minute budget — the page is asking a third party too often; raise the dataset's cacheTtlSeconds`,
    };
  }

  let answer: { ok: true; data: unknown } | { ok: false; message: string };
  try {
    answer = await callUpstream(connection, input.operation, input.args);
  } catch (error) {
    answer = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!answer.ok) return { status: "error", message: answer.message };

  let payload = stripBinary(answer.data);
  if (input.resultPath !== undefined) {
    // Walked against the RESPONSE — the path's root is the answer itself.
    const extracted = resolveResultPath(payload, input.resultPath);
    if (extracted === undefined) {
      return {
        status: "error",
        message: `resultPath "${input.resultPath}" found nothing in the answer — run dry_run to see its real shape.`,
      };
    }
    payload = extracted;
  }

  const result: PageQueryResult = { status: "ok", ...capRows(asRows(payload)) };
  try {
    // The one write that matters when the caller has already given up: an
    // answer that lands late is the next render's cache hit.
    await redis.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds);
  } catch {
    // A cache that refuses the write costs the next reader an upstream call.
  }
  return result;
};

export const externalPageQueryExecutor: ExternalPageQueryExecutor = {
  /**
   * The scheduling hint, answered from the manifest alone (see the interface).
   * A pinned connection is keyed by its id and an unpinned one by provider +
   * viewer-resolved connection — but the viewer is not known here, so the
   * provider key stands in: two datasets over the same serial provider run in
   * sequence even in the rare case they would have resolved to different
   * accounts. That costs a little parallelism and never costs correctness.
   */
  serialKey: (dataset) => {
    if (dataset.providerKey === undefined) return undefined;
    const providerKey = canonicalProviderKey(dataset.providerKey);
    const declared = getProvider(providerKey)?.manifest.concurrency;
    if (declared?.mode !== "serial") return undefined;
    return dataset.connectionId ?? providerKey;
  },
  execute: async (input) => {
    const resolution = await resolvePageConnection({
      teamId: input.teamId,
      userId: input.userId,
      ...(input.pageId !== undefined ? { pageId: input.pageId } : {}),
      ...(input.connectionId !== undefined
        ? { connectionId: input.connectionId }
        : {}),
      ...(input.providerKey !== undefined
        ? { providerKey: input.providerKey }
        : {}),
    });
    if (resolution.status !== "ok") return resolution;
    const { connection } = resolution;

    const ttlSeconds = Math.min(
      Math.max(
        input.cacheTtlSeconds ?? PAGE_LIMITS.defaultExternalTtlSeconds,
        PAGE_LIMITS.minExternalTtlSeconds,
      ),
      PAGE_LIMITS.maxExternalTtlSeconds,
    );
    // The resolved CONNECTION id keys the entry, so two viewers on their own
    // personal connections can never share an answer, while a whole team on
    // one shared connection does — exactly the sharing the data itself has.
    const cacheKey = `page:ext:v1:${connection.id}:${canonicalHash({
      operation: input.operation,
      args: input.args,
      resultPath: input.resultPath ?? null,
    })}`;

    if (input.fresh !== true) {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        try {
          return JSON.parse(cached) as PageQueryResult;
        } catch {
          // A malformed entry is a cache problem — recompute.
        }
      }
    }
    // How long THIS caller may wait: its own ceiling, and whatever is left of
    // the run's shared budget when a caller declared one. A page's external
    // datasets run one after another on a serial connection, so without the
    // shared budget a dead app would cost the render the sum of its widgets.
    const remaining =
      input.deadlineAt === undefined
        ? UPSTREAM_TIMEOUT_MS
        : Math.min(UPSTREAM_TIMEOUT_MS, input.deadlineAt - Date.now());

    let running = inFlight.get(cacheKey);
    if (running === undefined) {
      if (remaining < MIN_CALL_MS) return notAsked(connection);
      const execution = runQuery(input, connection, cacheKey, ttlSeconds);
      inFlight.set(cacheKey, execution);
      void execution.finally(() => {
        if (inFlight.get(cacheKey) === execution) inFlight.delete(cacheKey);
      });
      running = execution;
    }

    const settled = await waitFor(running, Math.max(remaining, 0));
    return settled === STILL_WORKING
      ? stillWorking(connection, remaining)
      : settled;
  },
};

/** One explicit registration at process boot — api and ai, nothing else. */
export const installExternalPageQueryExecutor = (): void => {
  registerExternalPageQueryExecutor(externalPageQueryExecutor);
};
