import type {
  ToolApprovalOpResult,
  ToolApprovalRequest,
} from "../../../db/schema";
import { getAction } from "../../../external-apps/registry";
import { resolveConnection } from "../../external-apps/connections/resolve";
import { extractFrameworkArgs } from "../../external-apps/exec/framework-args";
import { executeReadAction } from "../../external-apps/exec/read-executor";
import { markConsumed } from "../complete";
import type { ApprovalKindHandler } from "./types";

const iso = (d: Date | null): string => (d ?? new Date()).toISOString();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A successful read op-result carrying `{ data: { value } }`. */
const isOkData = (v: unknown): v is { ok: true; data: { value: unknown } } =>
  isRecord(v) && v.ok === true && isRecord(v.data) && "value" in v.data;

/**
 * `external_app_read` — ONE external-app READ action whose per-connection policy
 * escalated it to `approval`. Unlike a write plan, the read RUNS on grant and
 * its RAW mapped data is stored + replayed: the agent's re-run of the same read
 * code must get the exact wire shape the eager path returns, so `toSandboxData`
 * returns the data verbatim (not an op-result array). Reuses the `operations` +
 * `summary` columns (single op).
 */
export const externalAppReadHandler: ApprovalKindHandler = {
  kind: "external_app_read",
  execute: async ({ approval }): Promise<ToolApprovalOpResult[]> => {
    const op = approval.operations?.[0];
    if (op === undefined) {
      const result: ToolApprovalOpResult[] = [
        { ok: false, error: "external_app_read approval has no operation" },
      ];
      await markConsumed(approval.id, result);
      return result;
    }

    const result = await runRead(op.action, op.args, approval);
    await markConsumed(approval.id, [result]);
    return [result];
  },
  toSandboxData: (_approval, result) => {
    // The raw read data is wrapped in `{ value }` (read results can be arrays,
    // which the op-result `data: Record` type can't hold directly). Unwrap so
    // the Python SDK gets the exact shape the eager read path returns.
    const first: unknown = Array.isArray(result) ? result[0] : undefined;
    if (isOkData(first)) return first.data.value;
    return {};
  },
  toToolOutput: (approval) => ({
    status: "approval_granted",
    approvalId: approval.id,
    result: approval.result ?? [],
    grantedAt: iso(approval.decisionAt),
  }),
};

/** Re-resolve the action + connection from the stored op and run the read. The
 * op args carry the resolved `connection_id`, so the grant targets the exact
 * connection the proposal did. */
const runRead = async (
  qualifiedName: string,
  args: Record<string, unknown>,
  approval: ToolApprovalRequest,
): Promise<ToolApprovalOpResult> => {
  const resolved = getAction(qualifiedName);
  if (resolved === undefined) {
    return { ok: false, error: `Unknown action: ${qualifiedName}` };
  }
  try {
    const { framework, action: actionArgs } = extractFrameworkArgs(args);
    const connection = await resolveConnection({
      providerKey: resolved.providerKey,
      teamId: approval.teamId,
      userId: approval.userId,
      explicitId: framework.connection_id,
    });
    const data = await executeReadAction(resolved, connection, actionArgs);
    return { ok: true, data: { value: data } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
