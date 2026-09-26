import { SUB_AGENT_HANDBACK } from "../ai/remediation";
import { dispatchPlan } from "../external-apps/exec/plan";
import { dispatchRead } from "../external-apps/exec/read";
import { dispatchCollections } from "./collections";
import { isSubAgentExecScope } from "./exec-scope";
import type {
  ExecContext,
  SandboxExecRequest,
  SandboxExecResponse,
} from "./types";

/**
 * The collections-SDK ops a sub-agent may run: the ones that only READ. A
 * positive list, so an op added to the SDK is refused to sub-agents until
 * someone decides it is a read. `sync.refresh` is not here — it pulls rows
 * INTO a collection.
 */
const SUB_AGENT_COLLECTION_OPS: ReadonlySet<string> = new Set([
  "records.query",
  "sync.list",
  "sync.preview",
]);

const subAgentRefusal = (what: string): SandboxExecResponse => ({
  status: "error",
  message: `READ_ONLY_SUB_AGENT: a sub-agent does not ${what}. ${SUB_AGENT_HANDBACK}`,
});

/**
 * Entry point of `POST /sandbox/exec`. Routes a sandbox request to the read
 * path, the objects SDK, or the external-app write-plan gate. Authoritative
 * checks all live behind these dispatchers — the Python SDK's Pydantic
 * validation upstream is convenience, not security.
 *
 * A call made while a sub-agent's cell holds the sandbox is refused everything
 * that writes or would open an approval (see `exec-scope.ts` for why the
 * marker, not the credential, is what identifies it).
 */
export const dispatchSandboxExec = async (
  ctx: ExecContext,
  request: SandboxExecRequest,
): Promise<SandboxExecResponse> => {
  const readOnly = await isSubAgentExecScope(ctx.conversationId);
  if (request.kind === "read") {
    return dispatchRead({ ...ctx, readOnly }, request.action, request.args);
  }
  if (request.kind === "collections") {
    if (readOnly && !SUB_AGENT_COLLECTION_OPS.has(request.op)) {
      return subAgentRefusal(`run \`${request.op}\` — it changes team data`);
    }
    return dispatchCollections(ctx, request.op, request.args);
  }
  if (readOnly) {
    return subAgentRefusal("submit write plans to connected apps");
  }
  return dispatchPlan(ctx, request.operations);
};
