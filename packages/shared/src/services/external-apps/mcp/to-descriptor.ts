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
 * Classification: annotations only. A tool is a read exactly when its server
 * SAID SO (`readOnlyHint: true`); anything else is write-gated
 * (`kindSource: "default"`). There is deliberately no heuristic and no LLM
 * fallback: a single MCP tool is routinely both (Directus' `items` takes
 * `action: create|read|update|delete`), and guessing "read" there would put a
 * delete on the ungated eager path.
 *
 * Approval default follows that same signal — auto when the server declared the
 * tool read-only, `approval` when we cannot know. It is NOT a trust axis: the
 * curated/custom split died with the curated catalog, and keying the decision
 * on a vendor list instead of the tool's own declaration made every read of
 * every self-added server gate forever, which is not a security property, just
 * a permanent approval card. Per-connection `actionPolicies` are the knob for
 * the rest.
 */

export interface McpDescriptorInput {
  /** Catalog/provider key (kebab-case), e.g. `notion-mcp`. */
  key: string;
  displayName: string;
  description?: string;
  categories: string[];
  tools: McpTool[];
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

/**
 * Version of OUR compilation rules — classification, `approvalDefault`, the
 * Python codegen, and the SKILL prose. It is mixed into the fingerprint below.
 *
 * BUMP THIS whenever any of those four change. Snapshots are stored
 * get-or-insert by fingerprint (`upsertToolSnapshot`), and the fingerprint used
 * to hash only what the SERVER exposes — so changing how we compile a tool
 * produced an identical fingerprint, the nightly `mcp-refresh` found "no
 * drift", and every connection already in production kept its old descriptor
 * and its old SKILL forever. A rule change that no live connection can adopt is
 * not a change.
 *
 * History:
 *  - 2: reads auto-run when the server declares `readOnlyHint`; SKILL states
 *    explicitly when a server exposes no read tool at all.
 */
const COMPILER_VERSION = 2;

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
  hasher.update(JSON.stringify({ v: COMPILER_VERSION, tools: canonical }));
  return hasher.digest("hex").slice(0, 12);
};

const toAction = (tool: McpTool): ExternalAppDescriptorAction => {
  const classification = classifyByAnnotations(tool);
  const kind = classification?.kind ?? "write";
  const kindSource =
    classification !== undefined
      ? ("annotation" as const)
      : ("default" as const);

  // `kind === "read"` is reachable only through `readOnlyHint: true`, so a read
  // is always an explicit server declaration — auto-run it. Everything else,
  // declared write or simply unknown, gates.
  const approvalDefault =
    kind === "read" ? ("auto" as const) : ("approval" as const);

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
  actions: input.tools.map((tool) => toAction(tool)),
  triggers: [],
});
