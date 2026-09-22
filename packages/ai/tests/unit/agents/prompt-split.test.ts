/**
 * The claim the whole prompt-cache saving rests on, asserted directly.
 *
 * `instructions` is the front of the request. If one byte of it moves between
 * two turns of the same conversation, every provider in our fleet re-reads the
 * entire history behind it at full price — which is what happened for as long
 * as the clock, recall and the unlocked-tool snapshot lived in there. Measured
 * over 7 days of production traffic: 30 % of the previous turn's input came
 * back cached at a turn boundary, against 81 % between steps within a turn.
 *
 * So the test renders the REAL chatbot prompt twice against two contexts that
 * differ in every volatile field and nothing else, and demands that the system
 * message come back byte-identical. It is cheap, it needs no provider, and it
 * fails the moment someone adds a `{{placeholder}}` on the wrong side of the
 * split — which is exactly how this regression shipped the first time.
 */
import { describe, expect, test } from "bun:test";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import {
  buildChatbotSystemPrompt,
  buildWorkflowSystemPrompt,
} from "../../../src/agents/shared/prompt-renderer";
import type { AgentRuntimeContext } from "../../../src/agents/shared/runtime-context";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";

const ctxWith = (over: Partial<AgentRuntimeContext>): AgentRuntimeContext => ({
  organizationId: "org-1",
  teamId: "team-1",
  userId: "user-1",
  userName: "Alex",
  conversationId: "conv-1",
  timeZone: "Europe/Paris",
  modelProfile: getProfileForRole("chat"),
  dynamicToolManager: new DynamicToolManager(),
  chatbotContextManifest: "- context/handbook.md",
  teamCollectionsBlock: "- companies",
  attachedFilesBlock: "- attachments/quote.pdf",
  ...over,
});

describe("the chatbot prompt splits into a stable half and a volatile one", () => {
  test("everything that changes per turn leaves the system message", async () => {
    const first = await buildChatbotSystemPrompt(
      ctxWith({
        activeMemoryBlock: "FACTS: the client prefers e-mail (memory:a1)",
        memoryIndexBlock: "- team/process.md",
        standingMemoryBlock: "- shipped the Q3 report (episode:e1)",
        availableCapabilitiesBlock: "- weekly-recap (workflow)",
      }),
    );

    // A second turn of the SAME conversation: the clock has moved, recall
    // matched something else, a domain tool got unlocked, and a file in this
    // message is now native. Every one of those used to rewrite the prefix.
    const unlocked = new DynamicToolManager();
    unlocked.activate(["listRecords"]);
    const second = await buildChatbotSystemPrompt(
      ctxWith({
        dynamicToolManager: unlocked,
        timeZone: "America/New_York",
        activeMemoryBlock: "GRAPH: Acme Ltd — 3 open invoices (record:r9)",
        memoryIndexBlock: "- team/process.md\n- team/pricing.md",
        standingMemoryBlock: "- started the migration (episode:e2)",
        availableCapabilitiesBlock: "_None._",
        nativeIngestion: { native: ["quote.pdf"], toolOnly: [] },
      }),
    );

    expect(second.instructions).toBe(first.instructions);
    expect(second.turnContext).not.toBe(first.turnContext);
  });

  test("the volatile blocks are in the turn context and nowhere else", async () => {
    const { instructions, turnContext } = await buildChatbotSystemPrompt(
      ctxWith({
        activeMemoryBlock: "FACTS: recalled-fact-marker",
        memoryIndexBlock: "- memory-index-marker",
        standingMemoryBlock: "- standing-marker",
        availableCapabilitiesBlock: "- capability-marker",
      }),
    );

    for (const marker of [
      "recalled-fact-marker",
      "memory-index-marker",
      "standing-marker",
      "capability-marker",
      // The clock. Its timezone suffix is the cheapest thing to grep for that
      // cannot appear anywhere else in the prompt.
      "(Europe/Paris,",
    ]) {
      expect(turnContext).toContain(marker);
      expect(instructions).not.toContain(marker);
    }

    // And the block is self-delimiting: it has to survive being read as part
    // of a user message.
    expect(turnContext?.startsWith("<turn_context>")).toBe(true);
    expect(turnContext?.endsWith("</turn_context>")).toBe(true);
  });

  test("what is constant within a conversation stays in the system message", async () => {
    // The other half of the bargain. These three cost ~740 tokens and are
    // cached from turn 2 on — moving them into the turn context would pay for
    // them on every single turn instead.
    const { instructions, turnContext } = await buildChatbotSystemPrompt(
      ctxWith({}),
    );
    for (const marker of [
      "context/handbook.md",
      "- companies",
      "attachments/quote.pdf",
    ]) {
      expect(instructions).toContain(marker);
      expect(turnContext).not.toContain(marker);
    }
  });

  test("the workflow prompt keeps everything — its run is one cached prefix", async () => {
    // A run has nobody typing between turns, so its prompt is byte-stable for
    // the whole run by construction and there is nothing to move out. Per-turn
    // state rides its steering message instead.
    const { instructions, turnContext } = await buildWorkflowSystemPrompt(
      ctxWith({ workflowRunId: "run-1", playbookBlock: "1. Do the thing" }),
    );
    expect(turnContext).toBeUndefined();
    expect(instructions).toContain("Workflow run id: run-1");
  });
});
