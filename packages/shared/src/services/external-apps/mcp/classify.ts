import type { McpTool } from "./types";

/**
 * Read/write classification of an MCP tool from its `annotations` — the
 * ecosystem-standard signal (what Claude Code auto-approve and the ChatGPT
 * connectors key off). Annotations are OPTIONAL and UNTRUSTED per spec, so:
 *
 *  - `readOnlyHint === true`                      → read
 *  - `readOnlyHint === false` OR `destructiveHint` → write
 *  - no `readOnlyHint`                             → `undefined`
 *
 * `undefined` means "no annotation signal" — the caller then falls back to
 * a one-shot LLM classification (for un-annotated servers) or, absent that,
 * to write-gated. There is deliberately NO verb/keyword heuristic: MCP tool
 * names are arbitrary and multilingual, and there is no HTTP verb at this
 * layer.
 */
export interface AnnotationClassification {
  kind: "read" | "write";
  isDestructive: boolean;
}

export const classifyByAnnotations = (
  tool: McpTool,
): AnnotationClassification | undefined => {
  const ann = tool.annotations;
  if (ann === undefined) return undefined;

  if (ann.readOnlyHint === true) {
    return { kind: "read", isDestructive: false };
  }
  if (ann.readOnlyHint === false || ann.destructiveHint === true) {
    return { kind: "write", isDestructive: ann.destructiveHint === true };
  }
  return undefined;
};
