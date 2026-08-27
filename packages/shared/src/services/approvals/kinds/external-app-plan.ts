import { APPROVAL_GRANTED_NOTE } from "../../ai/approval-pending";
import { executePlan } from "../../external-apps/exec/plan-executor";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

/**
 * `external_app_plan` — a `run_plan([...])` write plan executed via Nango on
 * grant. `executePlan` writes partial results incrementally and marks the row
 * `consumed`; the sandbox wire shape is the raw per-op result array.
 */
export const externalAppPlanHandler: ApprovalKindHandler = {
  kind: "external_app_plan",
  execute: ({ approval }) =>
    executePlan({
      approval,
      teamId: approval.teamId,
      userId: approval.userId,
    }),
  toSandboxData: (_approval, result) => result,
  // `covers` + `note` exist because this output is substituted into a tool
  // result whose cell may have ABORTED at the raising call: everything after
  // it never ran. Without them the agent reads a bare success and reports work
  // it never submitted (observed: a 2-preparation plan shipped 1, summarised
  // as 2). Naming the operations makes the shortfall checkable.
  toToolOutput: (approval) => ({
    status: "approval_granted",
    approvalId: approval.id,
    result: approval.result ?? [],
    grantedAt: iso(approval.decisionAt),
    covers: approval.operations?.map((op) => op.action) ?? [],
    note: APPROVAL_GRANTED_NOTE,
  }),
};
