import type { PageValue } from "../../../schemas/pages";
import type { PageDataSource } from "./types";

/**
 * A connected app queried through MCP — DECLARED, not enabled.
 *
 * The kind exists so the shape is fixed before the first implementation and so
 * a page that asks for one gets a real answer instead of "unknown kind". The
 * same pattern `lang: "js"` followed on a transform, right up until it shipped.
 *
 * Six things have to exist before this resolves anything, and none of them do:
 *
 * 1. A uniform query verb. Today there are ~40 ad-hoc `list_*` actions with no
 *    common grammar — nothing a dataset could name generically.
 * 2. An execution path OUTSIDE a conversation. Every provider call currently
 *    wants `ExecContext{conversationId, turnId}`; the natural seam is
 *    `executeReadAction` (`exec/read-executor.ts`), which is already
 *    context-free, with `mcpCallTool` (`mcp/transport.ts`) beside it.
 * 3. A per-connection budget or quota. Nothing exists — a page view would be
 *    an unmetered upstream call.
 * 4. An explicit opt-in per connection: "this may feed a page".
 * 5. A guard against crowd-disabling. One upstream 401 flips a connection to
 *    `status: error`, so anonymous viewers of a public page could disable a
 *    team's integration by loading it.
 * 6. A rule keeping external datasets OFF `/p/<token>` in v1 — an anonymous
 *    route must not reach a third party on the team's credentials.
 *
 * WHAT THIS IS NOT FOR, whenever it does arrive: large volumes. A third party
 * cannot be filtered, grouped or indexed the way an object type can, and every
 * page view would pay a network round trip for rows nobody sorted. The
 * documented path for real volume is unchanged — a workflow syncs the data into
 * an object type, and the page queries THAT, in SQL, over indexed columns. This
 * source is for small, live reads whose value is their freshness.
 */

/**
 * What an implementation must provide. Registered from a package that may reach
 * the app layer, so `shared` keeps knowing nothing about MCP transports.
 *
 * The contract carries a CACHE by design rather than by later addition: a
 * dashboard's widget must not become a request to a third party on every
 * render. Between a 30 s MCP timeout, a per-connection budget and a crowd
 * arriving on a published link, "call it every time" is not an option that
 * exists — so the executor is expected to serve from a Redis entry keyed by
 * connection + operation + hashed args, and only miss occasionally.
 */
export interface ExternalPageQueryExecutor {
  execute: (input: {
    teamId: string;
    connectionId: string;
    operation: string;
    args: Record<string, PageValue>;
    resultPath?: string;
    /** Cache lifetime for this dataset's answer. Default 300 s. */
    cacheTtlSeconds?: number;
  }) => Promise<{ rows: PageValue[]; truncated: boolean }>;
}

let executor: ExternalPageQueryExecutor | undefined;

/**
 * Install the implementation. Until something calls this, the source refuses —
 * which is the whole point of the seam: the refusal is the default, and turning
 * it on is one explicit registration rather than a scattering of edits.
 */
export const registerExternalPageQueryExecutor = (
  implementation: ExternalPageQueryExecutor,
): void => {
  executor = implementation;
};

const NOT_ENABLED =
  "External app datasets are not enabled yet. Query the connected app in this conversation and store what the page needs, or model the data as an object type.";

export const externalSource: PageDataSource = {
  kind: "external",
  resolve: async (dataset, { teamId }) => {
    if (!executor) return { status: "error", message: NOT_ENABLED };
    if (!dataset.connectionId || !dataset.operation) {
      return {
        status: "error",
        message:
          "an external dataset needs connectionId and operation, both from the stored definition",
      };
    }
    // `args` are passed through UNRESOLVED: evaluating the bindings in them is
    // the implementation's job, because it is the same step that decides the
    // cache key. Sketching it here would be guessing at a contract nothing
    // exercises yet.
    const { rows, truncated } = await executor.execute({
      teamId,
      connectionId: dataset.connectionId,
      operation: dataset.operation,
      args: dataset.args ?? {},
      ...(dataset.resultPath !== undefined
        ? { resultPath: dataset.resultPath }
        : {}),
    });
    return { status: "ok", rows, truncated };
  },
};
