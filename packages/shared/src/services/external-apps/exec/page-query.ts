import { compilePageExpression } from "@fretik/render/runtime/expressions";
import type { ExternalAppConnection } from "../../../db/schema";
import { getAction } from "../../../external-apps/registry";
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
 *  - a page-specific timeout well under the transport's own 30 s — a slow app
 *    costs its widget a message, not the page a hang.
 *
 * And one invariant: this path NEVER writes `connection.status`. A page view
 * must not be able to flip a team's integration to `error`.
 */

const UPSTREAM_TIMEOUT_MS = 10_000;
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

/** In-flight upstream runs, keyed like the cache — joined even by `fresh`
 * requests: a run under way IS a fresh upstream answer. */
const inFlight = new Map<string, Promise<PageQueryResult>>();

const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `the app did not answer within ${(UPSTREAM_TIMEOUT_MS / 1000).toString()}s`,
        ),
      );
    }, UPSTREAM_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, gate]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

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
 * Whatever shape the app answered in, hand the page an array of row OBJECTS —
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
    const raw = await withTimeout(
      mcpCallTool(connection, action.mcpToolName, args),
    );
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
  const data = await withTimeout(
    executeReadAction(resolved, connection, validated),
  );
  return { ok: true, data };
};

const runQuery = async (
  input: PageQueryInput,
  connection: ExternalAppConnection,
  cacheKey: string,
  ttlSeconds: number,
): Promise<PageQueryResult> => {
  if (!(await underBudget(connection.id))) {
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
    const compiled = compilePageExpression(input.resultPath);
    if (compiled === null) {
      return {
        status: "error",
        message: `resultPath does not parse: ${input.resultPath}`,
      };
    }
    try {
      // Evaluated against the RESPONSE — the path's root is the answer itself.
      const extracted: unknown = await compiled.evaluate(payload);
      payload = extracted;
    } catch (error) {
      return {
        status: "error",
        message: `resultPath failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const result: PageQueryResult = { status: "ok", ...capRows(asRows(payload)) };
  await redis.set(cacheKey, JSON.stringify(result), "EX", ttlSeconds);
  return result;
};

export const externalPageQueryExecutor: ExternalPageQueryExecutor = {
  execute: async (input) => {
    const resolution = await resolvePageConnection({
      teamId: input.teamId,
      userId: input.userId,
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
    const running = inFlight.get(cacheKey);
    if (running !== undefined) return await running;

    const execution = runQuery(input, connection, cacheKey, ttlSeconds);
    inFlight.set(cacheKey, execution);
    try {
      return await execution;
    } finally {
      inFlight.delete(cacheKey);
    }
  },
};

/** One explicit registration at process boot — api and ai, nothing else. */
export const installExternalPageQueryExecutor = (): void => {
  registerExternalPageQueryExecutor(externalPageQueryExecutor);
};
