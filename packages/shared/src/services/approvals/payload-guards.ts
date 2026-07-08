import type {
  ToolApprovalPayload,
  ToolApprovalQuestionPayload,
  ToolApprovalRecordWritePayload,
} from "../../db/schema";

/**
 * Structural type guards for the kind-specific `payload` jsonb — narrows the
 * union without an `as` cast. `record_write` carries `items`, `question`
 * carries `questions`; the shapes are disjoint.
 */
export const isRecordWritePayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalRecordWritePayload =>
  payload !== null && "items" in payload;

export const isQuestionPayload = (
  payload: ToolApprovalPayload | null,
): payload is ToolApprovalQuestionPayload =>
  payload !== null && "questions" in payload;
