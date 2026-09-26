/**
 * The single canonical remediation directive for anything the team disabled
 * via tool-permission settings. Every agent-facing "X is disabled" string
 * ends with this sentence instead of restating it — one wording, one place
 * to change if the Settings page moves. The agent rephrases it for the user
 * in plain language; the directive itself is agent-facing.
 */
export const TOOL_PERMISSIONS_REMEDIATION =
  "Tell the user it can be re-enabled in Settings → Tool permissions.";

/**
 * Why a workflow run may not declare or reshape a sync source. Two doors reach
 * the rule — the `manageSync` tool and the Python `collections.sync.*` ops —
 * and a rule enforced on one door is enforced on neither.
 */
/**
 * What a sub-agent does when it reaches a write or an approval. It has no
 * channel to the user — its calls never reach the conversation's stream — so
 * the change goes back to the main assistant through its summary. Enforced at
 * two doors (the sub-agent's tool set, and `/sandbox/exec` for the Python
 * SDK), worded once here.
 */
export const SUB_AGENT_HANDBACK =
  "Leave it out and name it in your summary — the main assistant makes the change.";

export const SYNC_LOCKED_IN_WORKFLOW =
  "A run never creates or changes a sync source — it would add columns and schedule calls to a third party. Note the gap in the task summary. Refreshing an existing one is allowed.";
