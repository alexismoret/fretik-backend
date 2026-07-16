import type { ToolApprovalOperation } from "../../db/schema";

/**
 * Wire types for `POST /sandbox/exec` — the server side of the Python code-mode
 * SDK (`fretik_apps/_runtime.py`). Generic to the sandbox seam (reads,
 * external-app write plans, and the objects SDK), not external-apps.
 */

export type SandboxExecRequest =
  | { kind: "read"; action: string; args: Record<string, unknown> }
  | { kind: "plan"; operations: ToolApprovalOperation[] }
  | { kind: "objects"; op: string; args: Record<string, unknown> };

export type SandboxExecResponse =
  | { status: "ok"; data: unknown }
  | { status: "approval_pending"; approvalId: string }
  // Single-flight: another approval is already pending in this conversation, so
  // this one was NOT created. AI-side callers map it to a `deferredToolOutput`
  // marker (stops the turn, renders no card); the sandbox HTTP boundary maps it
  // to `error` (the sandbox SDK never sees this status).
  | { status: "approval_deferred"; blockingApprovalId: string }
  | { status: "error"; message: string; data?: unknown };

/** Execution context derived from the sandbox JWT. */
export interface ExecContext {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  turnId: string;
}
