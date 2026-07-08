import { getAction } from "../../../external-apps/registry";
import type { ExecContext, SandboxExecResponse } from "../../sandbox/types";
import { resolveConnection } from "../connections/resolve";
import { buildRequest } from "./build-request";
import { callCustomHandler } from "./call-custom-handler";
import { extractFrameworkArgs } from "./framework-args";
import { callHttpDirect } from "./http-direct";
import { callNangoProxy } from "./nango-proxy";
import { validateActionArgs } from "./validate-args";

/**
 * Read path of `POST /sandbox/exec` — a single external-app read action,
 * executed immediately via the resolved connection's transport. No approval
 * gate (reads never mutate). Authoritative validation lives here; the Python
 * SDK's Pydantic validation upstream is convenience, not security.
 */
export const dispatchRead = async (
  ctx: ExecContext,
  qualifiedName: string,
  args: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    return {
      status: "error",
      message: `Unknown action: ${qualifiedName}`,
    };
  }
  if (resolved.action.kind !== "read") {
    return {
      status: "error",
      message: `Action ${qualifiedName} is a write — submit it via run_plan().`,
    };
  }

  const { framework, action: actionArgs } = extractFrameworkArgs(args);

  let validated: Record<string, unknown>;
  try {
    validated = validateActionArgs(qualifiedName, resolved.action, actionArgs);
  } catch (error) {
    return {
      status: "error",
      message: `Invalid args for ${qualifiedName}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const connection = await resolveConnection({
      providerKey: resolved.providerKey,
      teamId: ctx.teamId,
      userId: ctx.userId,
      explicitId: framework.connection_id,
    });

    let data: unknown;
    if (resolved.transport.kind === "nango-proxy") {
      const req = buildRequest(resolved, validated);
      const raw = await callNangoProxy({
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        method: req.method,
        endpoint: req.endpoint,
        query: req.query,
        body: req.body,
      });
      data =
        resolved.responseMapper !== undefined
          ? resolved.responseMapper(raw)
          : raw;
    } else if (resolved.transport.kind === "http-direct") {
      const req = buildRequest(resolved, validated);
      const raw = await callHttpDirect({
        manifest: resolved.manifest,
        transport: resolved.transport,
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        method: req.method,
        endpoint: req.endpoint,
        query: req.query,
        body: req.body,
      });
      data =
        resolved.responseMapper !== undefined
          ? resolved.responseMapper(raw)
          : raw;
    } else {
      // custom-handler — the handler is responsible for returning the
      // shape declared by the manifest's `returns`. No response mapper.
      if (resolved.handler === undefined) {
        return {
          status: "error",
          message: `Action ${qualifiedName} has no handler registered`,
        };
      }
      data = await callCustomHandler({
        manifest: resolved.manifest,
        providerConfigKey: connection.nangoProviderConfigKey,
        connectionId: connection.nangoConnectionId,
        handler: resolved.handler,
        args: validated,
      });
    }
    return { status: "ok", data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", message };
  }
};
