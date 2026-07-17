import type { DynamicToolManager } from "../../agents/shared/dynamic-tools";

/**
 * Build the `<session_state>` heartbeat block injected at the bottom
 * of the system prompt's dynamic suffix on every turn.
 *
 * Pattern inspired by OpenClaw's `HEARTBEAT.md` section: a small
 * live snapshot of the current turn's runtime state — what domain
 * tools are unlocked — so the model doesn't waste a step
 * re-discovering things it already established earlier in the
 * conversation (or post-compaction, since the runtime managers
 * survive but the originating tool messages may not).
 *
 * Why this lives in the dynamic suffix (not the static prefix):
 * the snapshot changes every turn, so injecting it above the cache
 * boundary would invalidate the prompt cache. The implementation
 * intentionally avoids any I/O — `DynamicToolManager` already holds
 * the truth in process memory, so building the block costs ~µs per
 * turn.
 *
 * Out of scope for the MVP: filesystem listing of `/workspace/...`
 * and Python kernel state. Both would require an E2B sandbox
 * round-trip (~100–300ms) and the `<file_attachments>` section
 * already covers files attached to the current turn — the marginal
 * benefit doesn't justify the latency cost. Easy to add later if
 * the eval suite shows the model still wastes turns on `bash ls`.
 */

export interface SessionStateInputs {
  dynamicToolManager: DynamicToolManager;
}

/**
 * Render the live session-state block. Returns an empty string when
 * there is nothing useful to inject — the prompt renderer then
 * substitutes a friendly placeholder so the section never renders
 * as blank XML.
 */
export const buildSessionStateBlock = (inputs: SessionStateInputs): string => {
  const activatedTools = inputs.dynamicToolManager.getSnapshot();

  if (activatedTools.length === 0) return "";

  return `**Activated domain tools** (callable directly without re-running searchTools): ${activatedTools.join(", ")}`;
};
