/**
 * Deterministic codegen — turns a source-agnostic `CodegenProvider` view
 * (from a hand-written manifest today, an MCP introspection tomorrow) into
 * the Python SDK module + the SKILL.md the agent reads. Zero LLM, zero IO;
 * the CLI (`scripts/generate-sdk.ts`) owns discovery + file writes, this
 * lib owns the pure templating so the connection-time path can reuse it.
 */
export { compileMcpModule } from "./mcp-python-sdk";
export type { CompiledMcpModule } from "./mcp-python-sdk";
export {
  STATIC_MODULE_TEMPLATES,
  emitInit,
  emitProviderModule,
} from "./python-sdk";
export { emitManifestSkill, emitMcpSkill } from "./skill-md";
export type { ManifestSkillInput, McpSkillInput } from "./skill-md";
export type { CodegenAction, CodegenProvider } from "./types";
