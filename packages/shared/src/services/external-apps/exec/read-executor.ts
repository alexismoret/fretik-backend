import type { ExternalAppConnection } from "../../../db/schema";
import type { ResolvedAction } from "../../../external-apps/registry";
import { requireNangoRef } from "../connections/nango-ref";
import { buildRequest } from "./build-request";
import { callCustomHandler } from "./call-custom-handler";
import { callHttpDirect } from "./http-direct";
import { callNangoProxy } from "./nango-proxy";

/**
 * Run one resolved external-app READ action over its connection's transport and
 * return the mapped data. Extracted from `dispatchRead` so BOTH the eager path
 * (auto policy) and the approval-grant path (`external_app_read` kind, which
 * runs API-side and replays the raw data on the agent's re-run) share ONE
 * transport switch — a divergence between them would break the Python SDK's
 * read wire contract.
 *
 * Args must be pre-validated (`validateActionArgs`); the connection must be
 * already resolved. Throws on transport/handler failure — the caller maps it
 * to a sandbox error or a per-op result.
 */
export const executeReadAction = async (
  resolved: ResolvedAction,
  connection: ExternalAppConnection,
  validated: Record<string, unknown>,
): Promise<unknown> => {
  // A manifest connection is always Nango-backed (only a no-auth MCP server
  // isn't, and those never reach this executor).
  const { nangoProviderConfigKey, nangoConnectionId } =
    requireNangoRef(connection);

  if (resolved.transport.kind === "nango-proxy") {
    const req = buildRequest(resolved, validated);
    const raw = await callNangoProxy({
      providerConfigKey: nangoProviderConfigKey,
      connectionId: nangoConnectionId,
      method: req.method,
      endpoint: req.endpoint,
      query: req.query,
      body: req.body,
    });
    return resolved.responseMapper !== undefined
      ? resolved.responseMapper(raw)
      : raw;
  }

  if (resolved.transport.kind === "http-direct") {
    const req = buildRequest(resolved, validated);
    const raw = await callHttpDirect({
      manifest: resolved.manifest,
      transport: resolved.transport,
      providerConfigKey: nangoProviderConfigKey,
      connectionId: nangoConnectionId,
      method: req.method,
      endpoint: req.endpoint,
      query: req.query,
      body: req.body,
    });
    return resolved.responseMapper !== undefined
      ? resolved.responseMapper(raw)
      : raw;
  }

  // custom-handler — the handler returns the manifest's declared `returns`
  // shape. No response mapper.
  if (resolved.handler === undefined) {
    throw new Error(
      `Action ${resolved.providerKey}.${resolved.action.name} has no handler registered`,
    );
  }
  return callCustomHandler({
    manifest: resolved.manifest,
    providerConfigKey: nangoProviderConfigKey,
    connectionId: nangoConnectionId,
    handler: resolved.handler,
    args: validated,
  });
};
