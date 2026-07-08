import type { ToolApprovalKind } from "../../../db/schema";
import { externalAppPlanHandler } from "./external-app-plan";
import { questionHandler } from "./question";
import { recordWriteHandler } from "./record-write";
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
  record_write: recordWriteHandler,
  question: questionHandler,
};
