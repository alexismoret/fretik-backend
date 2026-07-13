import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../../lib/tool-error-codes";
import type { AgentRuntimeContext } from "./runtime-context";

/**
 * Server-side autonomy backstop for the direct object-write tools
 * (`manageRecord` / `manageLink`).
 *
 * The step-gate (`workflow-tool-gate`) only PRUNES these tools from the menu;
 * the AI SDK still EXECUTES a call the model emits by guessing the name
 * (verified: `parseToolCall` validates against the full registry, not
 * `activeTools`). So the prune is not airtight — a run under `read_only` /
 * `approval_required` could still write. This is the airtight backstop.
 *
 * Zero cost in chat: `ctx.workflowAutonomy` is threaded on the runtime
 * context and is `undefined` outside a workflow run — one comparison, no DB
 * lookup. Returns a teaching error to route the model to the gated Python SDK,
 * or `null` when the write is allowed (chat, or an `autonomous` run).
 */
export const workflowWriteBackstop = (
  ctx: AgentRuntimeContext,
): ToolErrorOutput | null => {
  if (ctx.workflowAutonomy === "read_only") {
    return toolError(
      TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
      "READ_ONLY workflow run — no record or link writes. Record what would change in the task summary instead.",
      "Direct writes are disabled in this autonomy mode.",
    );
  }
  if (ctx.workflowAutonomy === "approval_required") {
    return toolError(
      TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
      "APPROVAL_REQUIRED workflow run — write object records through the Python objects SDK (`records.bulk_create` / `bulk_update` / `bulk_delete`), which pauses on a record_write approval.",
      "Build the rows in `python` and call the SDK; the run pauses for human review, then resumes with the outcome.",
    );
  }
  return null;
};
