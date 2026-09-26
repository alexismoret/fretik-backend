import { BUILTIN_TOOL_POLICY_CATALOG } from "@fretik/shared/schemas/tool-policies";
import { describe, expect, test } from "bun:test";
import {
  buildCoreTools,
  buildDomainTools,
  buildSubAgentTools,
} from "../../../src/agents/chatbot/tools";
import { isSubAgentTool } from "../../../src/agents/shared/delegate-tool-policy";
import {
  isWebToolAvailable,
  WEB_TOOL_NAMES,
} from "../../../src/lib/web-egress";

/**
 * Structural invariants of the sub-agent tool registry.
 *
 * `buildSubAgentTools` lists its tools by name, and `isSubAgentTool` states
 * the rule they follow (reads and compute, no writes, nothing that talks to
 * the user). These tests hold the list to the rule in BOTH directions, which
 * is what makes the rule the source of truth: a new read tool fails here until
 * it is added to the list, and a write tool can never be.
 *
 * Imports from `chatbot/tools.ts` (env-free), same convention as
 * `chatbot-pd-integration.test.ts` — never from `chatbot/index.ts`, which
 * throws at import time without env.
 */
describe("sub-agent tool registry", () => {
  const names = new Set(Object.keys(buildSubAgentTools()));
  const domainTools = buildDomainTools();
  const chatRegistry = Object.keys({
    ...buildCoreTools(domainTools),
    ...domainTools,
  });

  test("carries every chat tool the rule admits, and no other", () => {
    for (const name of chatRegistry) {
      // A web tool the deployment has no key for is pruned from every agent,
      // sub-agents included — absent for that reason, not for the rule's.
      const pruned = WEB_TOOL_NAMES.has(name) && !isWebToolAvailable(name);
      const expected = isSubAgentTool(name) && !pruned;
      expect(`${name}:${names.has(name)}`).toBe(`${name}:${expected}`);
    }
  });

  test("carries no tool that writes to the team's data", () => {
    for (const [name, descriptor] of Object.entries(
      BUILTIN_TOOL_POLICY_CATALOG,
    )) {
      if (descriptor.kind === "write") expect(names.has(name)).toBe(false);
    }
  });

  test("excludes recursion, the user channel and memory writes", () => {
    for (const excluded of [
      "dispatchAgent",
      "buildPage",
      "searchTools",
      "askUserQuestion",
      "presentFiles",
      "memory",
      "createSkill",
      "updateSkill",
    ]) {
      expect(names.has(excluded)).toBe(false);
    }
  });

  test("keeps the read, search and compute workhorses", () => {
    for (const expected of [
      "searchKnowledge",
      "querySql",
      "read",
      "extract",
      "vision",
      "python",
      "bash",
      "listDocuments",
      "listRecords",
      "getRecord",
      "describeCollection",
      "downloadDriveDocument",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });
});
