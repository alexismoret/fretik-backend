import type { ExternalAppConnection } from "../../../db/schema";
import { getAction } from "../../../external-apps/registry";
import type { PageValue } from "../../../schemas/pages";
import { resolveConnectionActionPolicy } from "../../tool-policies/resolve";
import { requireNangoRef } from "../connections/nango-ref";
import { isMcpConnection } from "../mcp/connection-kind";
import { normalizeMcpResult } from "../mcp/normalize";
import { getSnapshotForConnection } from "../mcp/snapshot-store";
import { mcpCallTool } from "../mcp/transport";
import { buildRequest } from "./build-request";
import { callCustomHandler } from "./call-custom-handler";
import { callHttpDirect } from "./http-direct";
import { callNangoProxy } from "./nango-proxy";
import { validateActionArgs } from "./validate-args";

/**
 * Run one page OPERATION — a write into a connected app, triggered by a person
 * clicking a button on a page.
 *
 * The sibling of `mcp-plan.ts` / `plan-executor.ts` with the conversation
 * machinery removed: no `ExecContext`, no approval row, no plan. It cannot use
 * them because `runApprovalGate` is scoped by conversation id (NOT NULL, keyed,
 * single-flight per conversation) and a page has none — and because the reason
 * that gate exists does not apply here. An approval card asks a human to vet
 * what an AGENT decided to do; here the human decided, and the confirmation
 * happens in front of them before the request leaves.
 *
 * What DOES survive from that path, because it protects against the person's
 * own mistakes rather than the agent's:
 *  - `blocked` in the connection's action policies refuses outright;
 *  - an action the app itself marks DESTRUCTIVE is refused unless the page
 *    declared a confirmation step (checked by the caller, which is the only
 *    place holding both the descriptor and the definition).
 */

export type PageRunOutcome =
  | { status: "ok"; result: unknown }
  | { status: "blocked"; message: string }
  | { status: "error"; message: string };

/** Ceiling on one operation's upstream call — a person is waiting on it. */
const UPSTREAM_TIMEOUT_MS = 20_000;

const withTimeout = async <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `the app did not answer within ${(UPSTREAM_TIMEOUT_MS / 1000).toString()}s — it may still have gone through, so check there before retrying`,
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

const blockedMessage = (
  actionName: string,
  connection: ExternalAppConnection,
): string =>
  `"${actionName}" is disabled on connection "${connection.displayName}" by its permission settings — an admin can change that under Settings → Tool permissions`;

/**
 * What the caller must know BEFORE running: whether the action exists, whether
 * it is allowed, and whether the app calls it destructive. Separated from the
 * call so the confirmation rule can be enforced without a round trip.
 */
export interface PageActionDescriptor {
  name: string;
  kind: "read" | "write";
  destructive: boolean;
  level: "auto" | "approval" | "blocked";
}

export const describePageAction = async (
  connection: ExternalAppConnection,
  actionName: string,
): Promise<
  { ok: true; action: PageActionDescriptor } | { ok: false; message: string }
> => {
  if (isMcpConnection(connection)) {
    const snapshot = await getSnapshotForConnection(connection);
    if (snapshot === undefined) {
      return {
        ok: false,
        message: `connection "${connection.displayName}" is still preparing its tools — retry shortly`,
      };
    }
    const action = snapshot.descriptor.actions.find(
      (candidate) => candidate.name === actionName,
    );
    if (action === undefined) {
      return {
        ok: false,
        message: `unknown action "${actionName}" on ${connection.providerKey}`,
      };
    }
    return {
      ok: true,
      action: {
        name: action.name,
        kind: action.kind,
        destructive: action.annotations?.destructiveHint === true,
        level: resolveConnectionActionPolicy({
          action: { name: action.name, kind: action.kind },
          actionPolicies: connection.actionPolicies,
          autonomy: null,
        }),
      },
    };
  }

  const resolved = getAction(`${connection.providerKey}.${actionName}`);
  if (resolved === undefined) {
    return {
      ok: false,
      message: `unknown action "${actionName}" on ${connection.providerKey}`,
    };
  }
  return {
    ok: true,
    action: {
      name: resolved.action.name,
      kind: resolved.action.kind,
      // A manifest action carries no destructive hint; its kind is the signal,
      // and a write already needs a policy that allows it.
      destructive: false,
      level: resolveConnectionActionPolicy({
        action: { name: resolved.action.name, kind: resolved.action.kind },
        actionPolicies: connection.actionPolicies,
        autonomy: null,
      }),
    },
  };
};

/** Call the app. The caller has already vetted the action and the policy. */
export const runPageAction = async (params: {
  connection: ExternalAppConnection;
  actionName: string;
  args: Record<string, PageValue>;
}): Promise<PageRunOutcome> => {
  const { connection, actionName, args } = params;

  try {
    if (isMcpConnection(connection)) {
      const snapshot = await getSnapshotForConnection(connection);
      const action = snapshot?.descriptor.actions.find(
        (candidate) => candidate.name === actionName,
      );
      if (action === undefined) {
        return {
          status: "error",
          message: `unknown action "${actionName}" on ${connection.providerKey}`,
        };
      }
      const result = await withTimeout(
        mcpCallTool(connection, action.mcpToolName ?? action.name, args),
      );
      return { status: "ok", result: normalizeMcpResult(result) };
    }

    const qualifiedName = `${connection.providerKey}.${actionName}`;
    const resolved = getAction(qualifiedName);
    if (resolved === undefined) {
      return {
        status: "error",
        message: `unknown action "${actionName}" on ${connection.providerKey}`,
      };
    }

    let validated: Record<string, unknown>;
    try {
      validated = validateActionArgs(qualifiedName, resolved.action, args);
    } catch (error) {
      return {
        status: "error",
        message: `invalid arguments: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const { nangoProviderConfigKey, nangoConnectionId } =
      requireNangoRef(connection);

    if (resolved.transport.kind === "custom-handler") {
      if (resolved.handler === undefined) {
        return {
          status: "error",
          message: `action "${actionName}" has no handler registered`,
        };
      }
      const raw = await withTimeout(
        callCustomHandler({
          manifest: resolved.manifest,
          providerConfigKey: nangoProviderConfigKey,
          connectionId: nangoConnectionId,
          handler: resolved.handler,
          args: validated,
        }),
      );
      return { status: "ok", result: raw };
    }

    const request = buildRequest(resolved, validated);
    const raw =
      resolved.transport.kind === "http-direct"
        ? await withTimeout(
            callHttpDirect({
              manifest: resolved.manifest,
              transport: resolved.transport,
              providerConfigKey: nangoProviderConfigKey,
              connectionId: nangoConnectionId,
              method: request.method,
              endpoint: request.endpoint,
              query: request.query,
              body: request.body,
            }),
          )
        : await withTimeout(
            callNangoProxy({
              providerConfigKey: nangoProviderConfigKey,
              connectionId: nangoConnectionId,
              method: request.method,
              endpoint: request.endpoint,
              query: request.query,
              body: request.body,
            }),
          );
    return {
      status: "ok",
      result:
        resolved.responseMapper !== undefined
          ? resolved.responseMapper(raw)
          : raw,
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export { blockedMessage as pageActionBlockedMessage };
