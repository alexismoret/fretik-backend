import { callToolOnTarget, listToolsOnTarget } from "./client";
import { type McpConnectionTarget, resolveMcpTarget } from "./target";
import type { McpCallToolResult, McpTool } from "./types";

/**
 * Facade over the direct MCP transport: a connection row in, tools/list or
 * tools/call out. Each call resolves the row to a concrete `{ url, headers }`
 * target (`resolveMcpTarget` — SSRF-guarded, auth headers per kind) and drives
 * the `@ai-sdk/mcp` Streamable-HTTP client (`client.ts`). Every call site
 * already holds the connection row, so this is the single entry point; nothing
 * downstream knows about Nango's old `/proxy/mcp` passthrough (removed).
 */

/** List a connection's MCP tools. */
export const mcpListTools = async (
  connection: McpConnectionTarget,
): Promise<McpTool[]> => {
  const target = await resolveMcpTarget(connection);
  return listToolsOnTarget(target);
};

/** Call one MCP tool on a connection with the given arguments. */
export const mcpCallTool = async (
  connection: McpConnectionTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallToolResult> => {
  const target = await resolveMcpTarget(connection);
  return callToolOnTarget(target, name, args);
};
