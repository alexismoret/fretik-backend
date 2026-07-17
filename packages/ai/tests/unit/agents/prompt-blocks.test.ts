import { describe, expect, test } from "bun:test";
import { resolveAgentBlocks } from "../../../src/agents/shared/prompt-blocks";

/**
 * The unified system-prompt source serves BOTH agents; a resolution bug
 * would silently leak interactive-only guidance into the headless executor
 * (or the reverse) and break the per-agent prompt-cache stability. These
 * tests pin the contract on the real template.
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->\n?/g;
const strip = (s: string): string => s.replace(HTML_COMMENT_RE, "").trim();

const UNIFIED = await Bun.file(
  new URL("../../../src/agents/shared/agent-system-prompt.md", import.meta.url),
).text();

describe("resolveAgentBlocks", () => {
  test("keeps matching blocks, drops the other agent's, removes all markers", () => {
    const input = [
      "shared head",
      "<!-- AGENT:chatbot -->",
      "chatbot only",
      "<!-- /AGENT -->",
      "<!-- AGENT:workflow -->",
      "workflow only",
      "<!-- /AGENT -->",
      "shared tail",
      "",
    ].join("\n");
    expect(resolveAgentBlocks(input, "chatbot")).toBe(
      "shared head\nchatbot only\nshared tail\n",
    );
    expect(resolveAgentBlocks(input, "workflow")).toBe(
      "shared head\nworkflow only\nshared tail\n",
    );
  });

  test("chatbot variant of the real template has no workflow leakage", () => {
    const chatbot = strip(resolveAgentBlocks(UNIFIED, "chatbot"));
    expect(chatbot).not.toContain("completeTask");
    expect(chatbot).not.toContain("<execution_loop>");
    expect(chatbot).not.toContain("<writes_and_approvals>");
    expect(chatbot).not.toContain("{{playbookBlock}}");
    expect(chatbot).not.toContain("AGENT:");
    // Interactive essentials present.
    expect(chatbot).toContain("askUserQuestion");
    expect(chatbot).toContain("<proactive_partnership>");
    expect(chatbot).toContain("{{collaborationBlock}}");
  });

  test("workflow variant of the real template has no chatbot leakage", () => {
    const workflow = strip(resolveAgentBlocks(UNIFIED, "workflow"));
    expect(workflow).not.toContain("<proactive_partnership>");
    expect(workflow).not.toContain("{{collaborationBlock}}");
    expect(workflow).not.toContain("{{userName}}");
    expect(workflow).not.toContain("AGENT:");
    // Headless essentials present.
    expect(workflow).toContain("completeTask");
    expect(workflow).toContain("<execution_loop>");
    expect(workflow).toContain("<writes_and_approvals>");
    expect(workflow).toContain("{{playbookBlock}}");
    expect(workflow).toContain("{{workflowRunId}}");
    // The blocking askUserQuestion is now a headless tool (it parks the run
    // on a `question` approval), so it legitimately appears in the workflow prompt.
    expect(workflow).toContain("askUserQuestion");
    // Byte-stable per run (W2): everything that mutates per turn — current
    // date, live task statuses/recall/session-state — moved to the steering
    // message, so these are ABSENT from the workflow system prompt.
    expect(workflow).not.toContain("{{currentDate}}");
    expect(workflow).not.toContain("{{sessionStateBlock}}");
    expect(workflow).not.toContain("{{activeMemoryBlock}}");
    expect(workflow).not.toContain("<session_state>");
    expect(workflow).not.toContain("<active_memory>");
  });

  test("shared operational sections are present in BOTH variants", () => {
    const chatbot = strip(resolveAgentBlocks(UNIFIED, "chatbot"));
    const workflow = strip(resolveAgentBlocks(UNIFIED, "workflow"));
    for (const section of [
      "<identity>",
      "<working_method>",
      "<communication>",
      "<workspace>",
      "<tool_routing>",
      "<skills>",
      "<external_apps>",
      "<drive_documents>",
      "<domain_tools>",
      "<citations>",
      "<objects>",
      "<sql_rules>",
      "<database_schema>",
      "<platform_map>",
      "<critical_reminders>",
      "{{teamObjects}}",
    ]) {
      expect(chatbot).toContain(section);
      expect(workflow).toContain(section);
    }
    // `{{activeMemoryBlock}}` / `<session_state>` are chatbot-only now — the
    // workflow variant carries recall in its steering message (W2).
    expect(chatbot).toContain("{{activeMemoryBlock}}");
    expect(chatbot).toContain("<session_state>");
  });
});
