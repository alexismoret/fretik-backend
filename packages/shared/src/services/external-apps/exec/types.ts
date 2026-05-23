import type { ToolApprovalOperation } from "../../../db/schema";

/**
 * Wire types for `POST /sandbox/exec` — match the contract `_runtime.py`
 * speaks in the Python SDK (`fretik_apps/_runtime.py`).
 */

export type SandboxExecRequest =
  | { kind: "read"; action: string; args: Record<string, unknown> }
  | { kind: "plan"; operations: ToolApprovalOperation[] };

export type SandboxExecResponse =
  | { status: "ok"; data: unknown }
  | { status: "approval_pending"; approvalId: string }
  | { status: "error"; message: string; data?: unknown };

/** Execution context derived from the sandbox JWT. */
export interface ExecContext {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
}
