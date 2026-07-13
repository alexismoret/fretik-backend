/**
 * Minimal MCP wire types — only what Fretik reads from `tools/list` and
 * `tools/call`. The direct transport (`client.ts`) maps `@ai-sdk/mcp`'s richer
 * result types down to these, so the descriptor + normalizer stay decoupled
 * from the client library.
 */

/** Behavioural hints from `tools/list` (spec: OPTIONAL and UNTRUSTED). */
export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One entry of an MCP server's `tools/list`. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema (draft-07) of the tool's arguments. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

/** A block of a `tools/call` result's `content` array. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image" | "audio";
      data: string;
      mimeType: string;
    }
  | {
      type: "resource";
      resource: {
        uri?: string;
        mimeType?: string;
        text?: string;
        blob?: string;
      };
    }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string };

/** The `result` of a `tools/call`. */
export interface McpCallToolResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}
