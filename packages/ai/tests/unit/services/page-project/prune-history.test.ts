import type { ModelMessage } from "ai";
import { describe, expect, test } from "bun:test";
import { prunePageWriteHistory } from "../../../../src/services/page-project/prune-history";

/**
 * The half of the page builder's bill nobody was looking at.
 *
 * The first multi-file build cut output tokens 45% against the design it
 * replaced and cost 19% MORE: 39 model calls, 3.25M input tokens, because every
 * file body written stayed in the history and was re-sent on every later step.
 * These cases pin the one thing that makes that shrink — and the two things
 * that must not.
 */

const writeCall = (
  files: { path: string; content: string }[],
  id = "call-1",
): ModelMessage => ({
  role: "assistant",
  content: [
    {
      type: "tool-call",
      toolCallId: id,
      toolName: "pageWrite",
      input: { files },
    },
  ],
});

/** The file bodies still present in a message list, flattened. */
const bodies = (messages: readonly ModelMessage[]): string[] => {
  const out: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      const input = Reflect.get(part, "input");
      if (typeof input !== "object" || input === null) continue;
      const files = Reflect.get(input, "files");
      if (!Array.isArray(files)) continue;
      for (const file of files) {
        if (typeof file !== "object" || file === null) continue;
        const content = Reflect.get(file, "content");
        if (typeof content === "string") out.push(content);
      }
    }
  }
  return out;
};

describe("prunePageWriteHistory", () => {
  test("a file written twice keeps only the body that survived", () => {
    const messages = [
      writeCall([{ path: "Page.vue", content: "FIRST VERSION" }], "a"),
      writeCall([{ path: "Page.vue", content: "SECOND VERSION" }], "b"),
    ];

    const pruned = prunePageWriteHistory(messages);
    expect(pruned).not.toBeNull();
    const kept = bodies(pruned ?? []);
    expect(kept).toContain("SECOND VERSION");
    expect(kept).not.toContain("FIRST VERSION");
    // Replaced, not deleted: the model must be able to tell the difference
    // between a file it never wrote and one whose body was dropped for it.
    expect(kept.join(" ")).toContain("superseded");
  });

  test("the LAST write of every file is untouched", () => {
    // This is the file, as the model believes it to be. Dropping it would make
    // the next step re-read what it just wrote — the exact cost being removed.
    const messages = [
      writeCall(
        [
          { path: "Page.vue", content: "PAGE" },
          { path: "components/A.vue", content: "COMPONENT A" },
        ],
        "a",
      ),
    ];

    expect(prunePageWriteHistory(messages)).toBeNull();
  });

  test("a batch loses only the paths that were rewritten", () => {
    const messages = [
      writeCall(
        [
          { path: "Page.vue", content: "PAGE V1" },
          { path: "lib/format.ts", content: "FORMAT" },
        ],
        "a",
      ),
      writeCall([{ path: "Page.vue", content: "PAGE V2" }], "b"),
    ];

    const kept = bodies(prunePageWriteHistory(messages) ?? []);
    expect(kept).toContain("PAGE V2");
    // Written once, in the same call as a file that was rewritten: still the
    // current version of `lib/format.ts`, and still needed.
    expect(kept).toContain("FORMAT");
    expect(kept).not.toContain("PAGE V1");
  });

  test("nothing to prune returns null rather than a copy", () => {
    // The SDK carries a `messages` override forward. Handing it an identical
    // array every step is work for nothing, so "no change" has to be sayable.
    const messages = [writeCall([{ path: "Page.vue", content: "ONLY" }])];
    expect(prunePageWriteHistory(messages)).toBeNull();
    expect(prunePageWriteHistory([])).toBeNull();
  });

  test("it touches nothing but page writes", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "build me a dashboard" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "r1",
            toolName: "pageRead",
            input: { path: "Page.vue" },
          },
        ],
      },
      writeCall([{ path: "Page.vue", content: "V1" }], "a"),
      writeCall([{ path: "Page.vue", content: "V2" }], "b"),
    ];

    const pruned = prunePageWriteHistory(messages) ?? [];
    expect(pruned[0]).toEqual(messages[0]);
    expect(pruned[1]).toEqual(messages[1]);
  });
});
