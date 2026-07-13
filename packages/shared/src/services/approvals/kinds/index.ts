import type { ToolApprovalKind } from "../../../db/schema";
import { externalAppPlanHandler } from "./external-app-plan";
import { externalAppReadHandler } from "./external-app-read";
import { questionHandler } from "./question";
import { recordWriteHandler } from "./record-write";
import { toolCallHandler } from "./tool-call";
import type { ApprovalKindHandler } from "./types";

/**
 * The kind registry. `runApprovalGate` and `execute-decision.ts` resolve the
 * strategy by `kind` here — the single place kinds are enumerated. Add a kind =
 * add a module + one line.
 */
export const APPROVAL_KIND_HANDLERS: Record<
  ToolApprovalKind,
  ApprovalKindHandler
> = {
  external_app_plan: externalAppPlanHandler,
  external_app_read: externalAppReadHandler,
  record_write: recordWriteHandler,
  tool_call: toolCallHandler,
  question: questionHandler,
};
