import type { ExternalAppConnection } from "../../db/schema";
import type {
  ActionBatch,
  ActionIncremental,
  ActionPagination,
  ParamSpec,
  ReturnSpec,
} from "../../external-apps/manifest-schema";
import { getAction } from "../../external-apps/registry";
import type { GovernorMode } from "../external-apps/exec/governor/permit";
import { executeReadAction } from "../external-apps/exec/read-executor";
import { validateActionArgs } from "../external-apps/exec/validate-args";
import { isMcpConnection } from "../external-apps/mcp/connection-kind";
import { normalizeMcpResult } from "../external-apps/mcp/normalize";
import { getSnapshotForConnection } from "../external-apps/mcp/snapshot-store";
import { mcpCallTool } from "../external-apps/mcp/transport";
import {
  resolveConnectionActionPolicy,
  resolveToolPolicy,
} from "../tool-policies/resolve";

/**
 * One read action, in the ONE shape the sync engine understands, whether it
 * came from a provider manifest or from an MCP server's `tools/list`.
 *
 * This is `page-query.ts::callUpstream` split in two: the resolution (which is
 * a decision, made once per run) and the call (which happens once per page).
 * The walker holds only the second, which is also what makes it testable
 * against a fake `call` with no registry, no Redis and no connection row.
 *
 * Policy is the page path's, for the page path's reason (§4.5 of the plan):
 * `blocked` refuses, and `approval` is treated as `auto` because there is no
 * conversation to approve in — a sync source is a read a person declared once,
 * exactly like a page dataset, and an approval card nobody can see is a source
 * that silently never runs.
 *
 * THE INVARIANT THIS PATH SHARES WITH THE PAGE PATH: it NEVER writes
 * `external_app_connections.status`. A third party that refuses one team's
 * credential must not be able to flip the connection to `error` for everyone;
 * the failure belongs in the SOURCE's `lastError`, which is where the UI reads
 * it and where reconnecting clears it.
 */
export interface SyncReadAction {
  /** Name as this connection dispatches it. */
  name: string;
  summary?: string;
  params: Record<string, ParamSpec>;
  returns?: ReturnSpec;
  /**
   * The declared shape of ONE row, `returns` already dereferenced against the
   * manifest's `types`. This is what lets the preview mark a column `declared`
   * rather than `inferred`, and it is why an MCP source proposes nothing:
   * `tools/list` compiles to `returns: {fields: {}}`, so there is no shape to
   * dereference and every column comes from sampling.
   */
  returnFields?: Record<string, ParamSpec>;
  pagination?: ActionPagination;
  batch?: ActionBatch;
  incremental?: ActionIncremental;
  /**
   * The transport already returns every page (`paginate: true` on a
   * nango-proxy action, walked server-side by the proxy). The walker then makes
   * exactly one call and treats the answer as whole.
   */
  walksItself: boolean;
  /** One upstream call. Args are literals; throws on transport failure. */
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

export type ResolveSyncActionResult =
  { ok: true; action: SyncReadAction } | { ok: false; message: string };

export interface ResolveSyncActionOptions {
  /**
   * How long the resolved `call` may wait for a permit before the governor
   * refuses it. A run passes `background` with its own deadline: it has
   * minutes where a person has seconds, and a refusal it can act on — the
   * walker turns one into a `rate_limited` stop that keeps its position and
   * reschedules, rather than a leg that gave up after the interactive 8 s.
   *
   * Left out, the default stands and the call behaves like any other read.
   * That is right for the preview, where somebody IS waiting.
   */
  governor?: GovernorMode;
}

/**
 * Resolve `operation` on `connection` into a callable read action.
 *
 * Every refusal is a VALUE, never a throw: a source whose action has vanished
 * (an MCP server dropped a tool, a provider renamed one) must end its run with
 * a `lastError` a person can read, not with an exception that looks like an
 * outage.
 */
export const resolveSyncAction = async (
  connection: ExternalAppConnection,
  operation: string,
  opts?: ResolveSyncActionOptions,
): Promise<ResolveSyncActionResult> => {
  if (isMcpConnection(connection)) {
    const snapshot = await getSnapshotForConnection(connection);
    if (snapshot === undefined) {
      return {
        ok: false,
        message: `connection "${connection.displayName}" is still preparing its tools — the next run will pick them up`,
      };
    }
    const action = snapshot.descriptor.actions.find(
      (candidate) => candidate.name === operation,
    );
    if (action === undefined) {
      return {
        ok: false,
        message: `"${operation}" no longer exists on ${connection.displayName} — the server's tool list changed; re-pick the operation on this source`,
      };
    }
    if (action.kind !== "read") {
      return {
        ok: false,
        message: `"${operation}" is a write — a sync source may only read`,
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
    if (level === "blocked") return { ok: false, message: blocked(operation) };
    const toolName = action.mcpToolName;
    return {
      ok: true,
      action: {
        name: action.name,
        summary: action.summary,
        params: action.params,
        returns: action.returns,
        ...(rowFields(action.returns, {}) !== undefined
          ? { returnFields: rowFields(action.returns, {}) }
          : {}),
        // An MCP server has nowhere in `tools/list` to declare any of the
        // three, so they are absent by construction and the walker falls back
        // to one call — correct, and visible in the UI as "first page only"
        // rather than a silent truncation.
        ...(action.pagination !== undefined
          ? { pagination: action.pagination }
          : {}),
        ...(action.batch !== undefined ? { batch: action.batch } : {}),
        ...(action.incremental !== undefined
          ? { incremental: action.incremental }
          : {}),
        walksItself: false,
        // `mcpCallTool` takes the permit itself (see its comment): the MCP
        // transport opens a new client per call, so the seat belongs there and
        // NOT here. Taking it again would deadlock against a serial
        // connection's own lock. The mode still has to reach it, or a run
        // would wait out the interactive budget on a transport that has no
        // manifest to say how patient it should be.
        call: async (args) =>
          normalizeMcpResult(
            await mcpCallTool(connection, toolName, args, opts?.governor),
          ),
      },
    };
  }

  const qualifiedName = `${connection.providerKey}.${operation}`;
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    return {
      ok: false,
      message: `unknown operation "${operation}" on ${connection.providerKey}`,
    };
  }
  if (resolved.action.kind !== "read") {
    return {
      ok: false,
      message: `"${operation}" is a write — a sync source may only read`,
    };
  }
  const level = resolveConnectionActionPolicy({
    action: { name: resolved.action.name, kind: "read" },
    actionPolicies: connection.actionPolicies,
    autonomy: null,
  });
  if (level === "blocked") return { ok: false, message: blocked(operation) };

  const manifestAction = resolved.action;
  return {
    ok: true,
    action: {
      name: manifestAction.name,
      ...(manifestAction.summary !== undefined
        ? { summary: manifestAction.summary }
        : {}),
      params: manifestAction.params,
      returns: manifestAction.returns,
      ...(rowFields(manifestAction.returns, resolved.manifest.types) !==
      undefined
        ? {
            returnFields: rowFields(
              manifestAction.returns,
              resolved.manifest.types,
            ),
          }
        : {}),
      ...(manifestAction.pagination !== undefined
        ? { pagination: manifestAction.pagination }
        : {}),
      ...(manifestAction.batch !== undefined
        ? { batch: manifestAction.batch }
        : {}),
      ...(manifestAction.incremental !== undefined
        ? { incremental: manifestAction.incremental }
        : {}),
      walksItself: manifestAction.paginate === true,
      // `executeReadAction` takes the permit. Nothing above it in this stack
      // may take it again — see the call-site table in `read-executor.ts`.
      call: async (args) =>
        await executeReadAction(
          resolved,
          connection,
          validateActionArgs(qualifiedName, manifestAction, args),
          opts,
        ),
    },
  };
};

const blocked = (operation: string): string =>
  `"${operation}" is disabled on this connection by its permission settings — an admin can change that under Settings → Tool permissions`;

/**
 * One row's declared fields, whichever way the action names them. A `{void}`
 * return and an empty inline `{fields}` both come back `undefined` — "declares
 * nothing" and "declares an empty object" are the same fact to a preview.
 */
const rowFields = (
  returns: ReturnSpec,
  types: Record<string, Record<string, ParamSpec>>,
): Record<string, ParamSpec> | undefined => {
  const named =
    "ref" in returns
      ? types[returns.ref]
      : "list" in returns
        ? types[returns.list]
        : "page" in returns
          ? types[returns.page]
          : "fields" in returns
            ? returns.fields
            : undefined;
  return named !== undefined && Object.keys(named).length > 0
    ? named
    : undefined;
};
