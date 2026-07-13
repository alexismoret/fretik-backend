import { z } from "@hono/zod-openapi";
import { toolApprovalOperationSchema } from "./approvals";

/**
 * Wire contract for `POST /sandbox/exec` — the server side of the Python
 * code-mode SDK (`fretik_apps/_runtime.py`). Generic to the sandbox seam
 * (reads, external-app write plans, and the objects SDK), not external-apps.
 */

export const sandboxExecRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("read"),
    action: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    turnId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("plan"),
    operations: z.array(toolApprovalOperationSchema).min(1),
    turnId: z.string().min(1),
  }),
  z.object({
    // Code-mode ontology SDK (`fretik_apps.objects`): bulk record writes +
    // schema migrations. Record writes are gated by workflow autonomy in
    // `dispatchObjects`; schema changes are blocked for any workflow run.
    kind: z.literal("objects"),
    op: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    turnId: z.string().min(1),
  }),
]);
export type SandboxExecRequestDto = z.infer<typeof sandboxExecRequestSchema>;

export const sandboxExecResponseSchema = z.union([
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({
    status: z.literal("approval_pending"),
    approvalId: z.uuid(),
  }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    data: z.unknown().optional(),
  }),
]);
export type SandboxExecResponseDto = z.infer<typeof sandboxExecResponseSchema>;
