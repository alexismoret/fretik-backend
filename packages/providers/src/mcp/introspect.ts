import type { McpCatalogMeta } from "@fretik/shared/db/schema";
import {
  setConnectionToolFingerprint,
  upsertToolSnapshot,
} from "@fretik/shared/services/external-apps/mcp/snapshot-store";
import type { McpConnectionTarget } from "@fretik/shared/services/external-apps/mcp/target";
import { mcpToolsToDescriptor } from "@fretik/shared/services/external-apps/mcp/to-descriptor";
import { mcpListTools } from "@fretik/shared/services/external-apps/mcp/transport";
import { compileMcpModule, emitMcpSkill } from "../codegen";

/**
 * Connection-time introspection: `tools/list` → classify → descriptor →
 * deterministic codegen → persisted snapshot, then point the connection at
 * that fingerprint. Lives in `@fretik/providers` because it's the only place
 * that can import BOTH the codegen (here) and the shared MCP building blocks
 * — the api confirm handler calls it as a one-liner (handlers stay thin).
 *
 * Trust comes from the persisted discovery metadata: an official (`verified`)
 * server's reads auto-run (`trust: "curated"`), everything else gates
 * (`"custom"`); writes always gate. Every snapshot is connection-scoped. The
 * direct transport (`mcpListTools`) reaches the server via the connection's
 * stored URL + per-kind auth — introspection knows nothing about the transport.
 */

/**
 * The connection fields introspection needs — the transport target plus the
 * discovery metadata (`description` + `catalogMeta`) that shape the descriptor.
 */
export type McpConnectionRef = McpConnectionTarget & {
  description: string | null;
  catalogMeta: McpCatalogMeta | null;
};

export interface McpIntrospectionResult {
  fingerprint: string;
  toolCount: number;
}

export const introspectMcpConnection = async (
  ref: McpConnectionRef,
): Promise<McpIntrospectionResult> => {
  // An official (verified) server's reads auto-run; everything else gates.
  const verified = ref.catalogMeta?.verified === true;

  const tools = await mcpListTools(ref);

  const descriptor = mcpToolsToDescriptor({
    key: ref.providerKey,
    displayName: ref.displayName,
    description: ref.description ?? undefined,
    categories: ref.catalogMeta?.categories ?? ["productivity"],
    tools,
    trust: verified ? "curated" : "custom",
  });

  // High-fidelity path: the stub + SKILL reference compile straight from the
  // tools' raw JSON Schemas (not the lossy ParamSpec), so the agent sees exact
  // types/bounds/allowed-values and bad calls fail locally in Pydantic.
  const toolSchemas: Record<string, unknown> = {};
  for (const tool of tools) {
    if (tool.inputSchema !== undefined)
      toolSchemas[tool.name] = tool.inputSchema;
  }
  const { sdkPy, skillReference } = compileMcpModule(descriptor, toolSchemas);
  const skillMd = emitMcpSkill({
    provider: descriptor,
    version: descriptor.fingerprint,
    skillReference,
  });

  await upsertToolSnapshot({
    providerKey: ref.providerKey,
    // Every MCP connection is a custom server now — connection-scoped snapshot.
    connectionId: ref.id,
    fingerprint: descriptor.fingerprint,
    descriptor,
    sdkPy,
    skillMd,
  });
  await setConnectionToolFingerprint(ref.id, descriptor.fingerprint);

  return { fingerprint: descriptor.fingerprint, toolCount: tools.length };
};
