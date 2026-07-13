import type {
  ExternalAppDescriptor,
  ExternalAppDescriptorAction,
} from "../../../schemas/external-app-descriptor";
import { classifyByAnnotations } from "./classify";
import { inputSchemaToParams } from "./json-schema-to-param";
import type { McpTool } from "./types";

/**
 * Build the unified `ExternalAppDescriptor` from an MCP server's `tools/list`.
 * Feeds the SAME deterministic codegen as manifests (the descriptor is a
 * structural superset of the codegen's `CodegenProvider`), so MCP apps get a
 * Python stub with no per-provider authoring.
 *
 * Classification: annotations first (the ecosystem standard); un-annotated
 * tools default to write-gated (`kindSource: "default"`) — the LLM fallback
 * for un-annotated servers is a later refinement. Approval defaults encode
 * trust: curated vendors auto-run reads; custom (`mcp-generic`) servers gate
 * reads too. Writes always gate.
 */

export interface McpDescriptorInput {
  /** Catalog/provider key (kebab-case), e.g. `notion-mcp`. */
  key: string;
  displayName: string;
  description?: string;
  categories: string[];
  tools: McpTool[];
  /** Curated vendor entry vs a team's own `mcp-generic` server. */
  trust: "curated" | "custom";
}

/** MCP tool name → Python-safe snake_case identifier. */
const toActionName = (toolName: string): string =>
  toolName
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

/** One-line summary for the SKILL index + stub docstring first line. */
const summarize = (tool: McpTool): string => {
  const raw = tool.description ?? tool.title ?? tool.name;
  const firstLine = raw.split("\n")[0]?.trim() ?? tool.name;
  const clean = firstLine.replace(/^#+\s*/, "").trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}…` : clean || tool.name;
};

/** Stable content hash of the tool surface — snapshot key + drift signal. */
const fingerprintTools = (tools: McpTool[]): string => {
  const canonical = [...tools]
    .map((t) => ({
      name: t.name,
      inputSchema: t.inputSchema ?? {},
      annotations: t.annotations ?? {},
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify(canonical));
  return hasher.digest("hex").slice(0, 12);
};

const toAction = (
  tool: McpTool,
  trust: "curated" | "custom",
): ExternalAppDescriptorAction => {
  const classification = classifyByAnnotations(tool);
  const kind = classification?.kind ?? "write";
  const kindSource =
    classification !== undefined
      ? ("annotation" as const)
      : ("default" as const);

  // read → auto for curated vendors, approval for custom servers; write always gates.
  const approvalDefault =
    kind === "read"
      ? trust === "curated"
        ? ("auto" as const)
        : ("approval" as const)
      : ("approval" as const);

  const annotations =
    tool.annotations !== undefined
      ? {
          readOnlyHint: tool.annotations.readOnlyHint,
          destructiveHint: tool.annotations.destructiveHint,
          idempotentHint: tool.annotations.idempotentHint,
        }
      : undefined;

  return {
    name: toActionName(tool.name),
    kind,
    kindSource,
    summary: summarize(tool),
    approvalDefault,
    params: inputSchemaToParams(tool.inputSchema),
    // MCP reads return arbitrary content — no named model. `{fields:{}}`
    // makes codegen emit a `dict[str, Any]` return.
    returns: { fields: {} },
    mcpToolName: tool.name,
    annotations,
  };
};

export const mcpToolsToDescriptor = (
  input: McpDescriptorInput,
): ExternalAppDescriptor => ({
  key: input.key,
  displayName: input.displayName,
  description: input.description,
  source: "mcp",
  transport: "mcp",
  fingerprint: fingerprintTools(input.tools),
  categories: input.categories,
  types: {},
  actions: input.tools.map((tool) => toAction(tool, input.trust)),
  triggers: [],
});
