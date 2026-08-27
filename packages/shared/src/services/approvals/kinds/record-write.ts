import { APPROVAL_GRANTED_NOTE } from "../../ai/approval-pending";
import { cancelBulkOperation } from "../../bulk-operations/cancel";
import { findOperationForApproval } from "../../bulk-operations/find";
import { startBulkOperation } from "../../bulk-operations/start";
import { executeRecordWriteApproval } from "../execute-record-write";
import { isRecordImportPayload, isRecordWritePayload } from "../payload-guards";
import { asRecordResults, recordWriteWire } from "./record-write-wire";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

/**
 * `record_write` — a gated bulk object write (create / update / delete) the
 * workflow executor issued through the Python `collections` SDK. Grant re-executes
 * the user-selected subset through the same bulk services the direct path uses.
 *
 * A STAGED IMPORT is the same kind with its rows parked in `bulk_operations`
 * (see `isRecordImportPayload`). It renders the same card and takes the same
 * decision; only the execution differs — it is handed to a worker rather than
 * run inline, because it takes minutes and must survive the tab that approved it.
 */
export const recordWriteHandler: ApprovalKindHandler = {
  kind: "record_write",
  execute: ({ approval, decision }) =>
    executeRecordWriteApproval({
      approval,
      selectedIndexes: decision?.selectedIndexes,
      edits: decision?.edits,
    }),
  deferExecution: (approval) => isRecordImportPayload(approval.payload),
  startDeferred: async ({ approval }) => {
    const operation = await findOperationForApproval(approval.id);
    if (operation === undefined) {
      throw new Error(
        `Approval ${approval.id} defers to a bulk operation that no longer exists`,
      );
    }
    await startBulkOperation(operation);
  },
  onReject: async (approval) => {
    if (!isRecordImportPayload(approval.payload)) return;
    await cancelBulkOperation({
      operationId: approval.payload.operationId,
      reason: approval.decisionFeedback ?? "Rejected by the user",
    });
  },
  toSandboxData: (approval, result) => {
    const payload = approval.payload;
    if (!isRecordWritePayload(payload)) return {};
    return recordWriteWire(payload, asRecordResults(result));
  },
  toToolOutput: (approval) => {
    // An import has not written anything yet at grant time — reporting
    // `createdRecords` here would put an empty array in history and let the
    // agent conclude the load produced nothing.
    if (isRecordImportPayload(approval.payload)) {
      return {
        status: "approval_granted",
        approvalId: approval.id,
        grantedAt: iso(approval.decisionAt),
        import: {
          operationId: approval.payload.operationId,
          total: approval.payload.totalRows,
          state: "running",
        },
      };
    }
    return {
      status: "approval_granted",
      approvalId: approval.id,
      createdRecords: approval.result ?? [],
      grantedAt: iso(approval.decisionAt),
      note: APPROVAL_GRANTED_NOTE,
    };
  },
};
