/**
 * The single canonical remediation directive for anything the team disabled
 * via tool-permission settings. Every agent-facing "X is disabled" string
 * ends with this sentence instead of restating it — one wording, one place
 * to change if the Settings page moves. The agent rephrases it for the user
 * in plain language; the directive itself is agent-facing.
 */
export const TOOL_PERMISSIONS_REMEDIATION =
  "Tell the user it can be re-enabled in Settings → Tool permissions.";
