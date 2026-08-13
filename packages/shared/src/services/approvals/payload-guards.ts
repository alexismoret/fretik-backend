import type {
  ToolApprovalPayload,
  ToolApprovalQuestionPayload,
  ToolApprovalRecordImportPayload,
  ToolApprovalRecordWritePayload,
  ToolApprovalToolCallPayload,
} from "../../db/schema";

/**
 * Structural type guards for the kind-specific `payload` jsonb — narrows the
 * union without an `as` cast. `record_write` carries `items`, `question`
 * carries `questions`, `tool_call` carries `toolName`; the shapes are disjoint.
 */
export const isRecordWritePayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalRecordWritePayload =>
  payload !== null && "items" in payload;

/**
 * A record write whose rows are staged in `bulk_operations` rather than carried
 * in the payload. Deliberately a REFINEMENT of `isRecordWritePayload`, not a
 * sibling: an import IS a record write, with `items` holding only the sample.
 * Every consumer that only needs "which type, what op, show me rows" keeps
 * matching it; the two that must behave differently — the grant, which hands
 * the load to a worker instead of writing inline, and the sandbox replay shape
 * — ask this narrower question.
 */
export const isRecordImportPayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalRecordImportPayload =>
  isRecordWritePayload(payload) && "operationId" in payload;

export const isQuestionPayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalQuestionPayload =>
  payload !== null && "questions" in payload;

export const isToolCallPayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalToolCallPayload =>
  payload !== null && "toolName" in payload;
