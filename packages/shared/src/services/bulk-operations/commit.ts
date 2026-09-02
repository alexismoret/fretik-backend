import { eq } from "drizzle-orm";
import db from "../../db";
import type { BulkOperation } from "../../db/schema";
import { bulkOperations, toolApprovalRequests } from "../../db/schema";
import { runApprovalGate } from "../approvals/gate";
import type { SandboxExecResponse } from "../sandbox/types";
import { countStagedItems } from "./begin";
import { emptyProgress } from "./progress";
import { BULK_OPERATION_EXECUTORS } from "./registry";
import { resumeBulkOperation } from "./resume";
import { finishBulkOperation } from "./runner";
import { importToolOutput } from "./tool-output";

/**
 * Close the upload and decide what happens next.
 *
 * `direct` — every chunk was already applied on arrival, so this only
 * finalizes (one index build for the whole load) and reports.
 *
 * `staged` — the rows are parked; ONE approval card now describes the whole
 * load. That card is the answer to "don't ship 200 000 records to the browser":
 * the reviewer sees a count, the target type, the detected columns and three
 * real rows, and grants once.
 */
export const commitBulkOperation = async (input: {
  operation: BulkOperation;
  /** Tenant context for the approval gate — the operation's own, re-stated by
   * the caller because the gate takes a structural subset. */
  gateContext: {
    organizationId: string;
    teamId: string;
    userId: string;
    conversationId: string;
    turnId: string;
  };
}): Promise<SandboxExecResponse> => {
  const { operation } = input;

  // Terminal already (a re-run after everything finished): replay, never
  // re-open. This is the branch that makes "re-run the exact same code" cheap
  // — nothing is uploaded and nothing is written.
  if (operation.status === "done") {
    return { status: "ok", data: importToolOutput(operation, null) };
  }
  // Same reading as the begin stage (`sandbox/collections.ts`), and it must
  // stay the same one: a failed drain is resumable from its ledger, a
  // cancelled load is a refusal. A re-run normally resumes at begin and never
  // reaches here; this branch covers the caller that arrives with an operation
  // id in hand.
  if (operation.status === "failed") {
    const resumed = await resumeBulkOperation(operation);
    if (resumed.state === "resumed") {
      return { status: "ok", data: importToolOutput(resumed.operation, null) };
    }
    if (resumed.state === "nothing_left") {
      return { status: "ok", data: importToolOutput(operation, null) };
    }
    return { status: "error", message: resumed.reason };
  }
  if (operation.status === "cancelled") {
    return {
      status: "error",
      message:
        operation.error ??
        "This load was cancelled. Ask the user before submitting it again.",
    };
  }

  // A load missing a chunk must never be granted: it would write a silently
  // incomplete table, which is worse than a refusal the agent can act on.
  const staged = await countStagedItems(operation.id);
  if (staged !== operation.totalItems) {
    return {
      status: "error",
      message: `Incomplete upload: ${staged.toString()} of ${operation.totalItems.toString()} rows were received. Re-run the same code — chunks already sent are skipped.`,
    };
  }

  if (operation.mode === "direct") {
    const progress = operation.progress ?? emptyProgress();
    const finished = await finishBulkOperation({
      operation,
      progress,
      status: "done",
    });
    return { status: "ok", data: importToolOutput(finished, null) };
  }

  // Already parked in front of a human — hand the caller back to the card.
  if (
    operation.status === "pending_approval" &&
    operation.approvalId !== null
  ) {
    return { status: "approval_pending", approvalId: operation.approvalId };
  }
  if (operation.status === "queued" || operation.status === "running") {
    return { status: "ok", data: importToolOutput(operation, null) };
  }

  const executor = BULK_OPERATION_EXECUTORS[operation.kind];
  return runApprovalGate({
    ctx: input.gateContext,
    kind: "record_write",
    // Never auto-granted here. A load only reaches `staged` mode BECAUSE the
    // policy demanded a human; `autoGrant` would contradict the decision that
    // put it on this path.
    autonomy: null,
    autoGrant: false,
    lookupHash: operation.lookupHash,
    validateBeforePending: () => executor.validateSample(operation),
    createPending: async () => {
      const payload = await executor.buildApprovalPayload(operation);
      // The card and the operation pointing at it commit together. Apart, a
      // crash in between leaves a pending approval the operation does not
      // know about — and the grant then resolves the operation through
      // `approvalId`, finds nothing, and the user's approval does nothing at
      // all. The dedup hash would even hand the same broken row back on a
      // re-run, so it never heals on its own.
      return db.transaction(async (tx) => {
        const [approval] = await tx
          .insert(toolApprovalRequests)
          .values({
            organizationId: operation.organizationId,
            teamId: operation.teamId,
            userId: operation.userId,
            conversationId: operation.conversationId,
            turnId: operation.turnId,
            kind: "record_write",
            lookupHash: operation.lookupHash,
            payload,
            // The FULL row count, not the sample's length — this is what the
            // card states and what makes it render its summary form.
            itemCount: operation.totalItems,
            status: "pending",
          })
          .returning();
        if (approval === undefined) {
          throw new Error("Failed to open the import approval");
        }
        await tx
          .update(bulkOperations)
          .set({ status: "pending_approval", approvalId: approval.id })
          .where(eq(bulkOperations.id, operation.id));
        return approval;
      });
    },
  });
};
