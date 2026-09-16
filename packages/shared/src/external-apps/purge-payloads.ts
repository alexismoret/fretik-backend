import type { ToolApprovalOperation } from "../db/schema/approvals";
import { canonicalHash } from "../services/approvals/hash";
import { isRecord } from "./json-access";
import type { ParamSpec } from "./manifest-schema";
import { getAction } from "./registry";

/**
 * Strip an executed plan's bulk payloads, keeping a fingerprint.
 *
 * `tool_approval_requests.operations` stores the executable args verbatim,
 * base64 and all — up to 20 MB of file bytes per row, ~27 MB once encoded.
 * Nothing ever removes them: approvals have no `expires_at` by design, there
 * is no retention worker, and only deleting the conversation cascades. The
 * same column is also serialised to the browser on every approval fetch.
 *
 * Before execution those bytes are load-bearing: they are what the user
 * approves and what `claimAndExecute` will send. Afterwards they are only
 * evidence, and `{bytes, sha256}` is evidence enough to answer "was this the
 * file we meant?" — the digest is the same one the plan's `lookupHash`
 * already carries.
 *
 * Scoped to `hashAsDigest` params, which is exactly the "large opaque
 * payload" flag. Deliberately NOT `excludeFromHash`: that marks volatile
 * PROSE — a message body — which is small and is the only record of what was
 * actually sent to a customer.
 */

interface PurgedPayload {
  bytes: number;
  sha256: string;
}

/** Decoded length of a base64 string, without allocating the buffer. */
const base64Bytes = (value: string): number => {
  const compact = value.replace(/\s+/g, "");
  if (compact === "") return 0;
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
};

const purged = (value: unknown): PurgedPayload => ({
  bytes: typeof value === "string" ? base64Bytes(value) : 0,
  sha256: canonicalHash(value),
});

const purgeValue = (value: unknown, spec: ParamSpec): unknown => {
  if (spec.type === "object" && spec.fields !== undefined) {
    if (!isRecord(value)) return value;
    return purgeArgs(value, spec.fields);
  }
  if (spec.type === "array" && spec.items !== undefined) {
    if (!Array.isArray(value)) return value;
    const items = spec.items;
    return value.map((v) => purgeValue(v, items));
  }
  return value;
};

const purgeArgs = (
  args: Record<string, unknown>,
  params: Record<string, ParamSpec>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const spec = params[key];
    if (spec === undefined) {
      result[key] = value;
      continue;
    }
    result[key] = spec.hashAsDigest ? purged(value) : purgeValue(value, spec);
  }
  return result;
};

/**
 * `null` when nothing in the plan carries a purgeable payload — the caller
 * skips the write rather than rewriting a column with its own contents.
 */
export const purgeExecutedPayloads = (
  operations: ToolApprovalOperation[],
): ToolApprovalOperation[] | null => {
  let changed = false;
  const next = operations.map((op) => {
    const resolved = getAction(op.action);
    // MCP-sourced action: no manifest, so nothing is flagged and there is
    // nothing this can safely identify as payload.
    if (resolved === undefined) return op;
    const args = purgeArgs(op.args, resolved.action.params);
    if (!changed && JSON.stringify(args) !== JSON.stringify(op.args)) {
      changed = true;
    }
    return { action: op.action, args };
  });
  return changed ? next : null;
};
