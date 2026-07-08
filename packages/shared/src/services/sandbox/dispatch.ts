import { dispatchPlan } from "../external-apps/exec/plan";
import { dispatchRead } from "../external-apps/exec/read";
import { dispatchObjects } from "./objects";
import type {
  ExecContext,
  SandboxExecRequest,
  SandboxExecResponse,
} from "./types";

/**
 * Entry point of `POST /sandbox/exec`. Routes a sandbox request to the read
 * path, the objects SDK, or the external-app write-plan gate. Authoritative
 * checks all live behind these dispatchers — the Python SDK's Pydantic
 * validation upstream is convenience, not security.
 */
export const dispatchSandboxExec = async (
  ctx: ExecContext,
  request: SandboxExecRequest,
): Promise<SandboxExecResponse> => {
  if (request.kind === "read") {
    return dispatchRead(ctx, request.action, request.args);
  }
  if (request.kind === "objects") {
    return dispatchObjects(ctx, request.op, request.args);
  }
  return dispatchPlan(ctx, request.operations);
};
