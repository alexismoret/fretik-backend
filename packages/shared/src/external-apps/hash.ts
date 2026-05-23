import type { ToolApprovalOperation } from "../db/schema/external-apps";
import { isRecord } from "./json-access";
import type { ParamSpec } from "./manifest-schema";
import { getAction } from "./registry";

/**
 * `lookupHash` — the gate key for a write-action plan.
 *
 * sha256 over the plan's operations after stripping every param marked
 * `excludeFromHash: true` in the manifest (volatile free-text bodies, …).
 * Frozen at pending-creation; matched on re-run so the agent's re-executed
 * code finds the same grant. Modifying a stable field changes the hash and
 * correctly forces a fresh approval; regenerating an excluded field (a
 * message body) does not.
 *
 * Order-significant: the operations array's order is part of the hash —
 * `[reply, send]` and `[send, reply]` are distinct plans.
 */

const stripExcluded = (
  args: Record<string, unknown>,
  params: Record<string, ParamSpec>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const spec = params[key];
    if (spec === undefined) {
      // Param not declared by the manifest (would be rejected by validation
      // upstream) — keep it so the hash still discriminates.
      result[key] = value;
      continue;
    }
    if (spec.excludeFromHash) continue;
    result[key] = stripExcludedValue(value, spec);
  }
  return result;
};

const stripExcludedValue = (value: unknown, spec: ParamSpec): unknown => {
  if (spec.type === "object" && spec.fields !== undefined) {
    if (!isRecord(value)) return value;
    return stripExcluded(value, spec.fields);
  }
  if (spec.type === "array" && spec.items !== undefined) {
    if (!Array.isArray(value)) return value;
    const items = spec.items;
    return value.map((v) => stripExcludedValue(v, items));
  }
  return value;
};

/** Canonical JSON: keys sorted at every level, `undefined` dropped. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) sorted[key] = canonical(v);
    }
    return sorted;
  }
  return value;
};

export const computeLookupHash = (
  operations: ToolApprovalOperation[],
): string => {
  const stable = operations.map((op) => {
    const resolved = getAction(op.action);
    if (resolved === undefined) {
      throw new Error(`Unknown action while hashing plan: ${op.action}`);
    }
    return {
      action: op.action,
      args: stripExcluded(op.args, resolved.action.params),
    };
  });
  const json = JSON.stringify(canonical(stable));
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(json);
  return hasher.digest("hex");
};
