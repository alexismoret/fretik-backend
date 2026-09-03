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

  test("carries the eight page tools and the probes that answer what is in the data", () => {
    for (const required of [
      "pageRead",
      "pageWrite",
      "pageEdit",
      "pageSearch",
      "pageBuild",
      "pageProbe",
      "pageReview",
      "pageDocs",
      "describeCollection",
      "listRecords",
      "querySql",
      "read",
    ]) {
      expect(names).toContain(required);
    }
  });

  /**
   * Authoring moved to the `page*` tools, and `managePage` went with it: two
   * ways to write the same page is two write paths to keep honest, and the one
   * that stays is the one that holds a working copy.
   */
  test("does not carry managePage", () => {
    expect(names).not.toContain("managePage");
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
  test("carries text only — no channel a parent attachment could ride", () => {
    // Same isolation contract as `dispatchAgent`: everything the builder is
    // handed is a string it can read, so a file part in the parent's
    // conversation has no way through. Pinned as an exact list, because a new
    // key IS a new channel and this is where that gets decided rather than
    // noticed.
    expect(Object.keys(buildPageInputSchema.shape).sort()).toEqual([
      "collectionKeys",
      "description",
      "externalApps",
      "referenceFiles",
      "task",
    ]);
  });

  test("a reference is a PATH — contents have no way in", () => {
    // The distinction the isolation rests on: the builder opens the file
    // itself with `read`, which slices it and folds `data:` URIs. A mockup
    // pasted into the task string is a 30 kB line paid for on every step —
    // measured on the build where a reference HTML never reached the builder
    // at all, because there was no field for it (2026-08-28).
    const withContents = buildPageInputSchema.safeParse({
      task: "rebuild the cockpit from this mockup",
      description: "cockpit rebuild",
      referenceFiles: ["a".repeat(301)],
    });
    expect(withContents.success).toBe(false);
  });

  test("bounds the type keys it will resolve", () => {
    // Each key costs a field-definition read and a count; eight is already more
    // types than one page reads. The cap is what keeps a hallucinated list from
    // turning into a database sweep before the build even starts.
    expect(
      buildPageInputSchema.safeParse({
        task: "build the deals dashboard",
        description: "deals dashboard",
        collectionKeys: Array.from({ length: 9 }, (_, i) => `type_${i}`),
      }).success,
    ).toBe(false);
  });

  test("the type keys are optional — the builder can still probe for itself", () => {
    expect(
      buildPageInputSchema.safeParse({
        task: "build the deals dashboard",
        description: "deals dashboard",
      }).success,
    ).toBe(true);
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
