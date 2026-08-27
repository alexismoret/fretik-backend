import { withConnectionSlot } from "../exec/connection-slot";
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

/**
 * Past the transport's own 30 s ceiling (`client.ts`) — see `read-executor.ts`
 * for why a lease outlives the call it guards.
 */
const CALL_LEASE_MS = 35_000;

/**
 * Call one MCP tool on a connection with the given arguments.
 *
 * This is where the connection slot is taken for MCP, rather than in the two
 * callers (`page-query`, `page-run`), because `client.ts` opens a NEW client
 * per call — a page with N MCP datasets otherwise runs N `initialize`
 * handshakes at once against one server, and a server that is single-session or
 * rate-limits `initialize` fails some of them. Default is still `parallel`;
 * `concurrency_mode = 'serial'` on the connection is how an operator tames one.
 */
export const mcpCallTool = async (
  connection: McpConnectionTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallToolResult> =>
  await withConnectionSlot(
    connection,
    async () => {
      const target = await resolveMcpTarget(connection);
      return await callToolOnTarget(target, name, args);
    },
    { leaseMs: CALL_LEASE_MS },
  );
