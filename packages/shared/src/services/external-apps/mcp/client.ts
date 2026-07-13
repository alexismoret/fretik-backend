import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { arr, bool, isRecord, prop } from "../../../external-apps/json-access";
import type { McpTarget } from "./target";
import type {
  McpCallToolResult,
  McpContentBlock,
  McpTool,
  McpToolAnnotations,
} from "./types";

/**
 * Direct MCP-over-HTTP client — the transport-facing half of the MCP layer.
 * Wraps `@ai-sdk/mcp`'s Streamable-HTTP client (which owns the `initialize`
 * handshake, `Mcp-Session-Id`, protocol negotiation, and SSE/JSON framing) and
 * exposes only the two raw operations Fretik needs: `tools/list` and
 * `tools/call`. Results are mapped, guard by guard (no casts), into the minimal
 * `McpTool` / `McpCallToolResult` wire types the descriptor + normalizer read.
 *
 * `redirect: "error"` (the transport default) blocks a server redirecting us to
 * an internal host. A per-request timeout bounds every call, and a wrapping
 * `fetch` bounds the `initialize` too.
 */

const MCP_TIMEOUT_MS = 30_000;
/** Hard cap on `tools/list` pages — guards against a misbehaving server. */
const MAX_TOOL_PAGES = 50;

/**
 * A fetch that bounds every request (including `initialize`) with a timeout.
 * Typed as `typeof fetch` (carrying `preconnect`) to satisfy the transport's
 * `fetch` slot.
 */
const timeoutFetch: typeof fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    globalThis.fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(MCP_TIMEOUT_MS),
    }),
  { preconnect: globalThis.fetch.preconnect },
);

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Create a client for `target`, run `fn`, and ALWAYS close it. This is the one
 * seam where a future session cache (Redis `initialSessionId` /
 * `initialInitializeResult`) would slot in; today it's create-per-call, whose
 * one `initialize` round-trip is negligible against a chat turn.
 */
export const withMcpClient = async <T>(
  target: McpTarget,
  op: string,
  fn: (client: MCPClient) => Promise<T>,
): Promise<T> => {
  let client: MCPClient;
  try {
    client = await createMCPClient({
      clientName: "fretik",
      transport: {
        type: target.transportType === "sse" ? "sse" : "http",
        url: target.url,
        headers: target.headers,
        fetch: timeoutFetch,
      },
    });
  } catch (error) {
    throw new Error(
      `MCP ${op} failed for "${hostOf(target.url)}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return await fn(client);
  } catch (error) {
    throw new Error(
      `MCP ${op} failed for "${hostOf(target.url)}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
};

const mapAnnotations = (raw: unknown): McpToolAnnotations | undefined => {
  if (!isRecord(raw)) return undefined;
  const out: McpToolAnnotations = {};
  const title = prop(raw, "title");
  if (typeof title === "string") out.title = title;
  for (const hint of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    const value = prop(raw, hint);
    if (typeof value === "boolean") out[hint] = value;
  }
  return out;
};

const mapTool = (raw: unknown): McpTool | undefined => {
  const name = prop(raw, "name");
  if (typeof name !== "string" || name === "") return undefined;
  const tool: McpTool = { name };
  const title = prop(raw, "title");
  if (typeof title === "string") tool.title = title;
  const description = prop(raw, "description");
  if (typeof description === "string") tool.description = description;
  const inputSchema = prop(raw, "inputSchema");
  if (isRecord(inputSchema)) tool.inputSchema = inputSchema;
  const outputSchema = prop(raw, "outputSchema");
  if (isRecord(outputSchema)) tool.outputSchema = outputSchema;
  const annotations = mapAnnotations(prop(raw, "annotations"));
  if (annotations !== undefined) tool.annotations = annotations;
  return tool;
};

const mapContentBlock = (raw: unknown): McpContentBlock | undefined => {
  const type = prop(raw, "type");
  if (type === "text") {
    const text = prop(raw, "text");
    if (typeof text === "string") return { type: "text", text };
    return undefined;
  }
  if (type === "image" || type === "audio") {
    const data = prop(raw, "data");
    const mimeType = prop(raw, "mimeType");
    if (typeof data === "string" && typeof mimeType === "string") {
      return { type, data, mimeType };
    }
    return undefined;
  }
  if (type === "resource") {
    const r = prop(raw, "resource");
    if (!isRecord(r)) return undefined;
    const resource: McpContentBlock & { type: "resource" } = {
      type: "resource",
      resource: {},
    };
    for (const key of ["uri", "mimeType", "text", "blob"] as const) {
      const value = prop(r, key);
      if (typeof value === "string") resource.resource[key] = value;
    }
    return resource;
  }
  if (type === "resource_link") {
    const uri = prop(raw, "uri");
    if (typeof uri !== "string") return undefined;
    const block: McpContentBlock & { type: "resource_link" } = {
      type: "resource_link",
      uri,
    };
    const name = prop(raw, "name");
    if (typeof name === "string") block.name = name;
    const mimeType = prop(raw, "mimeType");
    if (typeof mimeType === "string") block.mimeType = mimeType;
    return block;
  }
  return undefined;
};

const mapCallResult = (raw: unknown): McpCallToolResult => {
  const result: McpCallToolResult = {};
  const content = arr(prop(raw, "content"))
    .map(mapContentBlock)
    .filter((b): b is McpContentBlock => b !== undefined);
  if (content.length > 0) result.content = content;
  const structured = prop(raw, "structuredContent");
  if (structured !== undefined) result.structuredContent = structured;
  if (isRecord(raw) && "isError" in raw) result.isError = bool(raw.isError);
  return result;
};

/**
 * List a target's tools, following cursor pagination so large/arbitrary
 * servers aren't truncated (capped at `MAX_TOOL_PAGES`).
 */
export const listToolsOnTarget = async (
  target: McpTarget,
): Promise<McpTool[]> =>
  withMcpClient(target, "tools/list", async (client) => {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      // eslint-disable-next-line no-await-in-loop -- cursor pagination is inherently sequential
      const res = await client.listTools({
        params: cursor !== undefined ? { cursor } : undefined,
        options: { timeout: MCP_TIMEOUT_MS },
      });
      for (const entry of res.tools) {
        const mapped = mapTool(entry);
        if (mapped !== undefined) tools.push(mapped);
      }
      if (typeof res.nextCursor !== "string") break;
      cursor = res.nextCursor;
    }
    return tools;
  });

/** Call one tool on a target with the given arguments. */
export const callToolOnTarget = async (
  target: McpTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallToolResult> =>
  withMcpClient(target, "tools/call", async (client) => {
    const res = await client.callTool({
      name,
      arguments: args,
      options: { timeout: MCP_TIMEOUT_MS },
    });
    return mapCallResult(res);
  });
