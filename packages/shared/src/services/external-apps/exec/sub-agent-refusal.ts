import { SUB_AGENT_HANDBACK } from "../../ai/remediation";
import type { SandboxExecResponse } from "../../sandbox/types";

/**
 * A read whose connection policy asks for the user's approval, made from a
 * sub-agent's cell. Nothing can show that approval — a sub-agent's calls never
 * reach the conversation — so the read goes back to the main assistant instead
 * of opening a card nobody sees (which would also block every later approval
 * in the conversation). Shared by the manifest and MCP read paths.
 */
export const approvalRefusedInSubAgent = (
  qualifiedName: string,
): SandboxExecResponse => ({
  status: "error",
  message: `APPROVAL_NEEDED: reading ${qualifiedName} needs the user's approval, which a sub-agent cannot ask for. ${SUB_AGENT_HANDBACK}`,
});
