import { describe, expect, test } from "bun:test";
import { buildPageBuilderTools } from "../../../src/agents/chatbot/tools";
import { buildPageInputSchema } from "../../../src/tools/build-page";

/**
 * The page builder is a delegate with a deliberately SHORT registry: building
 * a page is one ordered pipeline, and every tool outside it is a way to leave
 * the path. These pin the two properties that matter — it can build, and it
 * cannot delegate further or wander.
 */

describe("page-builder tool registry", () => {
  const tools = buildPageBuilderTools();
  const names = Object.keys(tools);

  test("carries the page tool and the probes that answer what is in the data", () => {
    for (const required of [
      "managePage",
      "describeObjectType",
      "listObjects",
      "querySql",
      "read",
    ]) {
      expect(names).toContain(required);
    }
  });

  test("cannot delegate — no dispatchAgent, and no buildPage recursion", () => {
    expect(names).not.toContain("dispatchAgent");
    expect(names).not.toContain("buildPage");
  });

  test("has nobody to ask and nothing to publish elsewhere", () => {
    // A delegate that asks a question stalls: the parent answers tool calls,
    // not the human. And a page build has no business writing to the Drive,
    // authoring skills or creating workflows.
    for (const absent of [
      "askUserQuestion",
      "uploadToDrive",
      "manageDrive",
      "createSkill",
      "manageWorkflow",
      "memory",
      "presentFiles",
    ]) {
      expect(names).not.toContain(absent);
    }
  });
});

describe("buildPage input", () => {
  test("takes a task and a label, and nothing that could carry media", () => {
    // Same isolation contract as `dispatchAgent`: the builder's whole channel
    // is one string, so parent attachments cannot leak into it.
    expect(Object.keys(buildPageInputSchema.shape).sort()).toEqual([
      "description",
      "task",
    ]);
  });

  test("refuses a one-word task", () => {
    // The builder never sees the conversation; a stub task is how a page ends
    // up being a title and a table.
    expect(
      buildPageInputSchema.safeParse({ task: "page", description: "a page" })
        .success,
    ).toBe(false);
  });
});
