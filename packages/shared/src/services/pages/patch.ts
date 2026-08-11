import { applySpecStreamPatch } from "@json-render/core";
import type { PageDefinition, PageDefinitionPatch } from "../../schemas/pages";
import { PageDefinitionSchema } from "../../schemas/pages";

/**
 * Apply an RFC 6902 patch to a page's definition.
 *
 * The point of the flat element map: an edit names the one thing it changes
 * (`/spec/elements/kpi-total/props/label`) instead of re-sending the document.
 * A whole-definition rewrite is still allowed — but it is how an author loses
 * an element that was fine, and the cost grows with the page.
 *
 * The patch runs on a CLONE (json-render's applier mutates) and the result is
 * re-parsed. That re-parse is load-bearing, not belt-and-braces: the applier
 * does NOT throw on an out-of-range array index (measured on 0.19.0) — it
 * writes something and returns, so a bad `/datasets/9/...` would otherwise
 * reach storage. Errors are returned, never thrown: a bad patch is something
 * the agent fixes on the next turn.
 */
export const applyPageDefinitionPatch = (
  definition: PageDefinition,
  patch: PageDefinitionPatch,
): { definition: PageDefinition } | { error: string } => {
  let draft: Record<string, unknown> = structuredClone({ ...definition });

  for (const [index, operation] of patch.entries()) {
    try {
      draft = applySpecStreamPatch(draft, operation);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        error: `patch operation ${index.toString()} (${operation.op} ${operation.path}) failed: ${message}`,
      };
    }
  }

  const parsed = PageDefinitionSchema.safeParse(draft);
  if (!parsed.success) {
    // Several issues at once usually share one cause (an op that wrote the
    // wrong shape), and reporting only the first sent the agent round the loop
    // once per issue. Three is enough to see the pattern without dumping the
    // whole tree back into the conversation.
    const shown = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join("/")} — ${issue.message}`)
      .join("; ");
    return {
      error: `the patched definition is no longer valid${shown ? `: ${shown}` : ""}`,
    };
  }
  return { definition: parsed.data };
};
