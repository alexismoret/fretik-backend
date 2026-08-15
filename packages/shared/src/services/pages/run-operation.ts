import type { PageRunResponse, PageValue } from "../../schemas/pages";
import { resolvePageConnection } from "../external-apps/connections/resolve-for-page";
import {
  describePageAction,
  pageActionBlockedMessage,
  runPageAction,
} from "../external-apps/exec/page-run";
import { getPage } from "./retrieve";
import { resolvePageState } from "./run-page-data";
import { resolveExternalArgs } from "./sources/external";
import type { PageRequester } from "./visibility";

/**
 * Run one of a page's declared operations — the WRITE half of a page.
 *
 * THE SECURITY BOUNDARY IS THE SAME ONE THE DATA PATH USES, deliberately. The
 * caller sends an operation id and values for the page's declared VARIABLES;
 * `resolvePageState` coerces those against their declared types and drops
 * everything else, exactly as it does for a dataset filter. The action name,
 * the connection and the argument template all come from the stored
 * definition, so a forged request can change a value that was already going to
 * be sent and nothing more.
 *
 * Three refusals stand between a click and a third party, and none of them is
 * the client's to make:
 *
 *  1. an operation the page does not declare — nothing to run;
 *  2. an action the connection's policies mark `blocked`;
 *  3. an action the app itself marks DESTRUCTIVE when the page declared no
 *     `confirm`. That check lives here because this is the only place holding
 *     both the app's descriptor and the page's definition — the sanitizer is
 *     pure and synchronous, so it cannot know what the app says about an
 *     action, and the frontend's dialog is a courtesy, not a control.
 */

/** Result payloads are for a toast and a refetch, never a data feed. */
const MAX_RESULT_CHARS = 32_000;

const cappedResult = (value: unknown): PageValue | undefined => {
  if (value === undefined || value === null) return undefined;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return undefined;
  if (encoded.length > MAX_RESULT_CHARS) {
    return `[result omitted: ${Math.round(encoded.length / 1000).toString()}KB]`;
  }
  // Parsed back rather than passed through: the wire shape is JSON, and a Date
  // or a class instance would not survive the response schema.
  return JSON.parse(encoded) as PageValue;
};

export const runPageOperation = async (params: {
  pageId: string;
  teamId: string;
  userId: string;
  requester?: PageRequester;
  operation: string;
  variables: Record<string, PageValue>;
}): Promise<PageRunResponse> => {
  const page = await getPage({
    pageId: params.pageId,
    teamId: params.teamId,
    ...(params.requester ? { requester: params.requester } : {}),
  });

  const operation = page.definition.operations.find(
    (candidate) => candidate.id === params.operation,
  );
  if (operation === undefined) {
    return {
      status: "error",
      message: `this page declares no operation "${params.operation}"`,
    };
  }

  // Same coercion the data path applies — declared variables only.
  const state = resolvePageState(page.definition, params.variables);

  const resolution = await resolvePageConnection({
    teamId: params.teamId,
    userId: params.userId,
    ...(operation.connectionId !== undefined
      ? { connectionId: operation.connectionId }
      : {}),
    ...(operation.providerKey !== undefined
      ? { providerKey: operation.providerKey }
      : {}),
  });
  if (resolution.status === "needs_connection") {
    return { status: "needs_connection", providerKey: resolution.providerKey };
  }
  if (resolution.status === "error") {
    return { status: "error", message: resolution.message };
  }
  const { connection } = resolution;

  const described = await describePageAction(connection, operation.action);
  if (!described.ok) {
    return { status: "error", message: described.message };
  }
  const action = described.action;

  if (action.level === "blocked") {
    return {
      status: "blocked",
      message: pageActionBlockedMessage(action.name, connection),
    };
  }
  if (action.destructive && operation.confirm === undefined) {
    return {
      status: "error",
      message: `"${action.name}" is destructive, so the page must declare a confirm step on operation "${operation.id}" before it can run.`,
    };
  }

  // The stored template, resolved against the coerced state. A binding that
  // yields nothing drops its argument rather than sending null.
  const resolvedArgs = resolveExternalArgs(operation.args ?? {}, state);
  if (!resolvedArgs.ok) {
    return { status: "error", message: resolvedArgs.error };
  }

  const outcome = await runPageAction({
    connection,
    actionName: action.name,
    args: resolvedArgs.args,
  });
  if (outcome.status !== "ok") return outcome;

  const result = cappedResult(outcome.result);
  return { status: "ok", ...(result !== undefined ? { result } : {}) };
};
