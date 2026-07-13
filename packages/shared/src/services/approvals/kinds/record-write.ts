import { executeRecordWriteApproval } from "../execute-record-write";
import { isRecordWritePayload } from "../payload-guards";
import { asRecordResults, recordWriteWire } from "./record-write-wire";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

/**
 * `record_write` — a gated bulk object write (create / update / delete) the
 * workflow executor issued through the Python `objects` SDK. Grant re-executes
 * the user-selected subset through the same bulk services the direct path uses.
 */
export const recordWriteHandler: ApprovalKindHandler = {
  kind: "record_write",
  execute: ({ approval, decision }) =>
    executeRecordWriteApproval({
      approval,
      selectedIndexes: decision?.selectedIndexes,
      edits: decision?.edits,
    }),
  toSandboxData: (approval, result) => {
    const payload = approval.payload;
    if (!isRecordWritePayload(payload)) return {};
    return recordWriteWire(payload, asRecordResults(result));
  },
  toToolOutput: (approval) => ({
    status: "approval_granted",
    approvalId: approval.id,
    createdRecords: approval.result ?? [],
    grantedAt: iso(approval.decisionAt),
  }),
};
