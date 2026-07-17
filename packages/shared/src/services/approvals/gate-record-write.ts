import type {
  ToolApprovalRecordWriteItem,
  ToolApprovalRecordWritePayload,
} from "../../db/schema";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import type { WorkflowAutonomy } from "../../schemas/workflows";
import { TOOL_PERMISSIONS_REMEDIATION } from "../ai/remediation";
import type { ExecContext, SandboxExecResponse } from "../sandbox/types";
import { resolveBuiltinToolPolicy } from "../tool-policies/resolve";
import { createPendingRecordWriteApproval } from "./create-pending-record-write";
import { runApprovalGate } from "./gate";
import { recordWriteLookupHash } from "./hash";

const READ_ONLY_MSG =
  "READ_ONLY_WORKFLOW: this run cannot write records. Note in the task summary what would have been written.";

/**
 * THE single record-write approval entrypoint, shared by both producers of
 * record writes: the Python `objects` SDK bulk path (`services/sandbox/objects.ts`)
 * and the builtin `manageRecord` tool (`@fretik/ai`). Both feed items through
 * here so a single OR a bulk record write parks the SAME `record_write` kind and
 * renders the SAME rich, editable card — never a raw `tool_call` dump.
 *
 * Gates by the resolved `manageRecord` policy level (`resolveBuiltinToolPolicy`
 * folds the team override AND workflow autonomy): `blocked` rejects (workflow
 * `read_only`, or a team that turned record writes off); `auto` writes directly
 * (no approval row); `approval` routes through the generic gate — a pending
 * `record_write` the user reviews, replayed on a re-run of the same call.
 * `buildPayload` is LAZY (its snapshot/metadata reads run only when a fresh
 * pending is actually created). Returns `SandboxExecResponse` (incl.
 * `approval_deferred` from single-flight); the caller maps it to its own output.
 */
export const gateRecordWriteApproval = (params: {
  ctx: ExecContext;
  autonomy: WorkflowAutonomy | null;
  teamPolicies: Record<string, ToolPolicyLevel>;
  op: ToolApprovalRecordWritePayload["op"];
  objectTypeId?: string;
  merge?: boolean;
  hashItems: ToolApprovalRecordWriteItem[];
  buildPayload: () => Promise<ToolApprovalRecordWritePayload>;
  directWrite: () => Promise<SandboxExecResponse>;
  /** Pre-approval dry-run: validate the rows before a human is asked to grant
   * (create/update; delete has nothing to validate). Reuses the bulk services'
   * own validation via their `dryRun` flag. */
  validateBeforePending?: () => Promise<{ index: number; error: string }[]>;
}): Promise<SandboxExecResponse> => {
  const level = resolveBuiltinToolPolicy({
    toolName: "manageRecord",
    teamPolicies: params.teamPolicies,
    autonomy: params.autonomy,
  });
  if (level === "blocked") {
    return Promise.resolve({
      status: "error",
      message:
        params.autonomy === "read_only"
          ? READ_ONLY_MSG
          : `RECORD_WRITES_DISABLED: the team disabled record writes for the assistant. ${TOOL_PERMISSIONS_REMEDIATION}`,
    });
  }
  if (level === "auto") {
    return params.directWrite();
  }
  const lookupHash = recordWriteLookupHash({
    op: params.op,
    objectTypeId: params.objectTypeId,
    merge: params.merge,
    items: params.hashItems,
  });
  return runApprovalGate({
    ctx: params.ctx,
    kind: "record_write",
    autonomy: params.autonomy,
    autoGrant: false,
    lookupHash,
    createPending: async () =>
      createPendingRecordWriteApproval({
        organizationId: params.ctx.organizationId,
        teamId: params.ctx.teamId,
        userId: params.ctx.userId,
        conversationId: params.ctx.conversationId,
        turnId: params.ctx.turnId,
        lookupHash,
        payload: await params.buildPayload(),
      }),
    ...(params.validateBeforePending !== undefined
      ? { validateBeforePending: params.validateBeforePending }
      : {}),
  });
};
