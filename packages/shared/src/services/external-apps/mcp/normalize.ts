import type { McpCallToolResult, McpContentBlock } from "./types";

/**
 * Turn an MCP `tools/call` result into the shape the sandbox runtime and
 * agent consume.
 *
 *  - `isError` → throw (the dispatcher maps it to a read/op error the agent
 *    sees and self-corrects on).
 *  - `structuredContent` → returned as-is (typed JSON).
 *  - otherwise the `content` blocks are normalized: a lone text block becomes
 *    the parsed JSON (or the raw string); media / resource blocks become
 *    dicts carrying `content_base64` or `download_url`, so the runtime's
 *    existing `_spill_attachments` writes them to `/workspace/attachments`
 *    and the raw bytes never enter the agent's context.
 */

const parseIfJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed === "null" ||
    trimmed === "true" ||
    trimmed === "false"
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return text;
    }
  }
  return text;
};

const normalizeBlock = (block: McpContentBlock): unknown => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
    case "audio":
      return {
        type: block.type,
        mime_type: block.mimeType,
        content_base64: block.data,
      };
    case "resource": {
      const r = block.resource;
      if (r.blob !== undefined) {
        return {
          type: "resource",
          uri: r.uri,
          mime_type: r.mimeType,
          content_base64: r.blob,
        };
      }
      return {
        type: "resource",
        uri: r.uri,
        mime_type: r.mimeType,
        text: r.text,
      };
    }
    case "resource_link":
      return {
        type: "resource_link",
        download_url: block.uri,
        name: block.name,
      };
    default:
      return block;
  }
};

export const normalizeMcpResult = (result: McpCallToolResult): unknown => {
  if (result.isError === true) {
    const message = (result.content ?? [])
      .filter(
        (b): b is Extract<McpContentBlock, { type: "text" }> =>
          b.type === "text",
      )
      .map((b) => b.text)
      .join("\n");
    throw new Error(message === "" ? "MCP tool returned an error" : message);
  }

  if (result.structuredContent !== undefined) return result.structuredContent;

  const content = result.content ?? [];
  const onlyText = content.every((b) => b.type === "text");
  if (onlyText) {
    const texts = content.map((b) => (b.type === "text" ? b.text : ""));
    if (texts.length === 1) return parseIfJson(texts[0] ?? "");
    return texts.map((t) => parseIfJson(t));
  }

  return { content: content.map(normalizeBlock) };
};
