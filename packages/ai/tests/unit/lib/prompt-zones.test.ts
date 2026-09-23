/**
 * The guard that runs at DEPLOY time, on the text that will actually be served.
 *
 * Every failure it catches has the same shape: the prompt renders, the answer
 * is right, and the bill goes up. A `{{placeholder}}` one zone too high
 * re-reads the conversation history on every turn — measured over 7 days of
 * production traffic, that is the difference between 30 % and 81 % of the
 * previous turn's input coming back from cache.
 *
 * `seedLangfusePrompts` runs as a release task on every deploy, so an
 * assertion here fails the deploy rather than the invoice.
 */
import { describe, expect, test } from "bun:test";
import { resolveAgentBlocks } from "../../../src/agents/shared/prompt-blocks";
import {
  assertPromptZones,
  PROMPTS,
} from "../../../src/lib/langfuse-prompts/seed";

const MARKER = `<!--
DYNAMIC SUFFIX — every section below is re-rendered per turn
-->`;

const template = (below: string): string =>
  `Static doctrine, no placeholders.\n\n${MARKER}\n\n${below}\n`;

describe("assertPromptZones", () => {
  test("the real templates pass, both agents", async () => {
    // Not a smoke test: this is the assertion the deploy makes, run against
    // the file that will be published.
    const raw = await Bun.file(
      PROMPTS.find((p) => p.agent === "chatbot")?.path ?? "",
    ).text();
    for (const agent of ["chatbot", "workflow"] as const) {
      expect(() =>
        assertPromptZones(agent, resolveAgentBlocks(raw, agent)),
      ).not.toThrow();
    }
  });

  test("a placeholder above the marker is refused by name", () => {
    expect(() =>
      assertPromptZones(
        "t",
        `Doctrine with {{activeMemoryBlock}} in it.\n\n${MARKER}\n\nrest\n`,
      ),
    ).toThrow(/activeMemoryBlock/);
  });

  test("a per-turn placeholder in the conversation zone is refused", () => {
    // The regression this file exists for: below the marker looks safe, and
    // is not — the conversation suffix is cached from turn 2 on.
    expect(() =>
      assertPromptZones(
        "t",
        template("{{teamCollections}}\n\n{{activeMemoryBlock}}"),
      ),
    ).toThrow(/activeMemoryBlock/);
  });

  test("the same placeholder inside <turn_context> is fine", () => {
    expect(() =>
      assertPromptZones(
        "t",
        template(
          "{{teamCollections}}\n\n<turn_context>\n{{activeMemoryBlock}}\n</turn_context>",
        ),
      ),
    ).not.toThrow();
  });

  test("a second <turn_context> line is refused — the renderer cuts at the first", () => {
    expect(() =>
      assertPromptZones(
        "t",
        template(
          "<turn_context>\na\n</turn_context>\n\n<turn_context>\nb\n</turn_context>",
        ),
      ),
    ).toThrow(/2 lines open/);
  });

  test("naming the tag in prose is not a boundary", () => {
    // `<memory_protocol>` points forward to the block by name. Matching the
    // bare tag rather than the line would cut the prompt in half there.
    expect(() =>
      assertPromptZones(
        "t",
        template(
          "Three blocks ride in the `<turn_context>` on the latest user message.\n\n<turn_context>\n{{activeMemoryBlock}}\n</turn_context>",
        ),
      ),
    ).not.toThrow();
  });

  test("a template with no marker at all is refused", () => {
    expect(() => assertPromptZones("t", "no marker here")).toThrow(
      /marker not found/,
    );
  });
});
