import {
  BUILTIN_TOOL_POLICY_CATALOG,
  type ToolPolicyLevel,
} from "../../schemas/tool-policies";
import type { WorkflowAutonomy } from "../../schemas/workflows";

/**
 * THE single decision function for tool/action permissions. Combines the
 * team/connection override, the code default, and the run's workflow autonomy
 * into one effective level. Used identically by the AI prepareStep gate
 * (builtin tools) and the external-app dispatch (per-connection actions).
 *
 * Precedence (the user's confirmed rule — autonomy governs writes, but a
 * `blocked` override is absolute):
 *  1. `override === "blocked"` → `blocked`. An admin/owner ban is never
 *     resurrected by autonomy.
 *  2. `base = override ?? defaultLevel`.
 *  3. Plain chat (`autonomy === null`) OR a read → `base` unchanged (autonomy
 *     only governs writes).
 *  4. `read_only` → writes behave `blocked` (hidden — nothing writes).
 *  5. `approval_required` → a write escalates `auto → approval` (never below
 *     approval); `approval`/`blocked` unchanged.
 *  6. `autonomous` → a write's `approval → auto` (auto-grant, today's
 *     behaviour); `auto`/`blocked` unchanged.
 */
export const resolveToolPolicy = (params: {
  kind: "read" | "write";
  defaultLevel: ToolPolicyLevel;
  override: ToolPolicyLevel | undefined;
  autonomy: WorkflowAutonomy | null;
}): ToolPolicyLevel => {
  const { kind, defaultLevel, override, autonomy } = params;

  if (override === "blocked") return "blocked";
  const base = override ?? defaultLevel;

  if (autonomy === null || kind === "read") return base;
  if (autonomy === "read_only") return "blocked";
  if (autonomy === "approval_required")
    return base === "auto" ? "approval" : base;
  // autonomous
  return base === "approval" ? "auto" : base;
};

/**
 * Effective level for one builtin tool given the team's policy map + the run's
 * autonomy. Tools NOT in the catalog are infrastructure/core (python, bash,
 * memory, …) — always `auto`, never blockable.
 */
export const resolveBuiltinToolPolicy = (params: {
  toolName: string;
  teamPolicies: Record<string, ToolPolicyLevel>;
  autonomy: WorkflowAutonomy | null;
}): ToolPolicyLevel => {
  const descriptor = BUILTIN_TOOL_POLICY_CATALOG[params.toolName];
  if (descriptor === undefined) return "auto";
  return resolveToolPolicy({
    kind: descriptor.kind,
    defaultLevel: descriptor.defaultLevel,
    override: params.teamPolicies[params.toolName],
    autonomy: params.autonomy,
  });
};

/**
 * Effective level for one external-app action on a concrete connection. The
 * manifest is the registry: `read → auto`, `write → approval` by default; the
 * connection's `action_policies` map overrides per action.
 */
export const resolveConnectionActionPolicy = (params: {
  action: { name: string; kind: "read" | "write" };
  actionPolicies: Record<string, ToolPolicyLevel> | null | undefined;
  autonomy: WorkflowAutonomy | null;
}): ToolPolicyLevel =>
  resolveToolPolicy({
    kind: params.action.kind,
    defaultLevel: params.action.kind === "read" ? "auto" : "approval",
    override: params.actionPolicies?.[params.action.name],
    autonomy: params.autonomy,
  });
