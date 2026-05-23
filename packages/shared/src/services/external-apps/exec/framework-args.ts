/**
 * Framework-level args that every action implicitly accepts in the SDK
 * but that are NOT declared in the manifest's `params`. They drive
 * dispatcher behaviour, not the underlying API call.
 *
 *  - `connection_id` — pick a specific connection when the caller has
 *    several connections for the same provider (e.g. "Pro mailbox" and
 *    "Personal mailbox"). Without it, `resolveConnection` returns
 *    `EXTERNAL_APP_AMBIGUOUS_CONNECTION`.
 */
export interface FrameworkArgs {
  connection_id?: string;
}

/**
 * Split incoming op args into framework-level args (`connection_id`, …)
 * and the action's own args. The action args are then validated against
 * the manifest and forwarded to the request mapper.
 */
export const extractFrameworkArgs = (
  args: Record<string, unknown>,
): { framework: FrameworkArgs; action: Record<string, unknown> } => {
  const framework: FrameworkArgs = {};
  const action: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === "connection_id") {
      if (typeof value === "string" && value !== "") {
        framework.connection_id = value;
      }
      continue;
    }
    action[key] = value;
  }
  return { framework, action };
};
