import type { WorkflowAutonomy } from "@fretik/shared/schemas/workflows";

/**
 * Write-tool gate for workflow runs — the single source of truth for which
 * tools a run may expose, by autonomy. Enforced by PRUNING the tool menu
 * (`activeTools`), never by rejecting a call: the model never sees a withheld
 * tool, so no turn is wasted and no schema is paid for. Code surfaces that
 * can't be pruned (the Python objects SDK, `run_plan`) stay gated server-side
 * via `getWorkflowAutonomyForConversation`.
 *
 * Applied in two places against the SAME rules:
 *  - the main workflow agent (`agents/workflow/index.ts`), whose registry
 *    already omits `WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`, so it prunes writes +
 *    memory only (`workflowMainHiddenToolNames`);
 *  - workflow-dispatched sub-agents (`agents/chatbot/index.ts`), which share
 *    the chat registry and so must also prune the schema/meta tools per-step
 *    (`workflowSubAgentHiddenToolNames`).
 */

/** Direct team-data write tools — withheld unless the run is `autonomous`.
 * Object writes otherwise go through the gated Python objects SDK
 * (`records.bulk_*`); the Drive tools (`manageDrive`/`uploadToDrive`) have no
 * gated escalation, so a non-autonomous run simply cannot reorganise the Drive. */
export const WORKFLOW_WRITE_TOOLS = [
  "manageRecord",
  "manageLink",
  "manageDrive",
  "uploadToDrive",
] as const;

/** Tools removed when a run is `read_only` — no data OR memory writes. */
export const WORKFLOW_READ_ONLY_HIDDEN_TOOLS = [
  ...WORKFLOW_WRITE_TOOLS,
  "memory",
] as const;

/** Tools removed when a run is `approval_required` — object writes must go
 * through the gated Python objects SDK, so the direct write tools are withheld;
 * `memory` stays (memory writes aren't gated team-data writes). */
export const WORKFLOW_APPROVAL_HIDDEN_TOOLS = WORKFLOW_WRITE_TOOLS;

/**
 * Schema + meta tools a run NEVER uses, in any mode: schema edits
 * (`manageObjectType`/`manageField`), skill drafts that need chat confirmation
 * (`createSkill`/`updateSkill`), and workflow building (`manageWorkflow`,
 * anti-recursion). The main workflow agent drops these from its registry at
 * build time (`buildWorkflowTools`); a sub-agent shares the chat registry, so
 * it hides them per-step instead. Keep in sync with `buildWorkflowTools`.
 */
export const WORKFLOW_FORBIDDEN_DOMAIN_TOOLS = [
  "manageObjectType",
  "manageField",
  "createSkill",
  "updateSkill",
  "manageWorkflow",
] as const;

/**
 * Tool names the MAIN workflow agent withholds at a step, by autonomy. Writes
 * + memory only — its registry already excludes `WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`.
 */
export const workflowMainHiddenToolNames = (
  autonomy: WorkflowAutonomy,
): ReadonlySet<string> => {
  if (autonomy === "read_only")
    return new Set<string>(WORKFLOW_READ_ONLY_HIDDEN_TOOLS);
  if (autonomy === "approval_required")
    return new Set<string>(WORKFLOW_APPROVAL_HIDDEN_TOOLS);
  return new Set<string>();
};

/**
 * Tool names a SUB-AGENT running inside a workflow withholds, by autonomy — a
 * superset of the main gate that also hides `WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`
 * (the sub-agent shares the chat registry, which still carries them). Same
 * rules as the main agent; the run's autonomy is poured in via `workflowAutonomy`.
 */
export const workflowSubAgentHiddenToolNames = (
  autonomy: WorkflowAutonomy,
): ReadonlySet<string> => {
  const hidden = new Set<string>(WORKFLOW_FORBIDDEN_DOMAIN_TOOLS);
  for (const name of workflowMainHiddenToolNames(autonomy)) hidden.add(name);
  return hidden;
};
