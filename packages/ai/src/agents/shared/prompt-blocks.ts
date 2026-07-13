/**
 * Agent-conditional blocks for the UNIFIED system-prompt source
 * (`agent-system-prompt.md`) — one git file serves both the chatbot and the
 * workflow executor; the sections that differ are wrapped in marker comments:
 *
 *     <!-- AGENT:chatbot -->
 *     …chatbot-only paragraphs / bullets / sections…
 *     <!-- /AGENT -->
 *     <!-- AGENT:workflow -->
 *     …workflow-only variant…
 *     <!-- /AGENT -->
 *
 * Unmarked text is shared. Resolution keeps the matching agent's block
 * contents (markers removed) and drops non-matching blocks entirely, BEFORE
 * the generic HTML-comment strip — so markers never reach the model and the
 * resolved text is byte-stable per agent (prompt caching intact).
 *
 * Discipline for editors: block granularity is a whole paragraph, bullet, or
 * section — never mid-sentence, never nested. Both the runtime fallback
 * loader (`prompt-renderer.ts`) and the Langfuse seed script
 * (`scripts/seed-langfuse-prompts.ts`) call this, so the stored prompts stay
 * byte-identical to what the runtime renders.
 *
 * PURE module: no imports, no side effects — safe for the seed script to
 * import without pulling the agent module graph (DB / Redis / OTel).
 */

export type PromptAgentKind = "chatbot" | "workflow";

const AGENT_BLOCK_RE =
  /<!-- AGENT:(chatbot|workflow) -->\n([\s\S]*?)<!-- \/AGENT -->\n?/g;

export const resolveAgentBlocks = (
  text: string,
  agent: PromptAgentKind,
): string =>
  text.replace(AGENT_BLOCK_RE, (_match, blockAgent: string, body: string) =>
    blockAgent === agent ? body : "",
  );
