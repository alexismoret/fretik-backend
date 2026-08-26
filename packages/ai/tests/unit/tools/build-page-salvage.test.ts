import { describe, expect, test } from "bun:test";
import {
  findOrphanFence,
  formatBuildResult,
  type BuildSteps,
} from "../../../src/tools/build-page";

/**
 * The rescue path: a build that WROTE its page and died before saving it.
 *
 * This is the failure the fence protocol makes recoverable. Ten times on
 * 2026-08-26 a builder spent two minutes emitting a complete SFC and the
 * upstream cut the connection before the write landed; the source was gone
 * with the tool-call arguments, and the parent's only remedy was a rebuild
 * from zero. Now the source is ordinary text in the trajectory, so the two
 * questions that matter are "is one here" and "did the run already save it" —
 * and answering the second one wrongly overwrites a reviewed page with a
 * draft.
 */

const PAGE = "<template>\n  <div>Deals</div>\n</template>";
const fenced = (body: string): string => `\`\`\`vue\n${body}\n\`\`\``;

const step = (over: {
  text?: string;
  calls?: { toolCallId: string; toolName: string; input: unknown }[];
  results?: { toolCallId: string; toolName: string; output: unknown }[];
}) => ({
  text: over.text ?? "",
  toolCalls: over.calls ?? [],
  toolResults: over.results ?? [],
});

const wrote = (toolCallId: string, action: "create" | "update") => ({
  toolCallId,
  toolName: "managePage",
  input: { action, definition: { code: { source: "@emitted" } } },
});

const saved = (toolCallId: string, pageId: string) => ({
  toolCallId,
  toolName: "managePage",
  output: { pageId, url: `/pages/${pageId}` },
});

describe("findOrphanFence", () => {
  test("a page written and never saved is an orphan", () => {
    const steps: BuildSteps = [
      step({ text: "Probing the data." }),
      step({ text: `Here is the page:\n${fenced(PAGE)}` }),
    ];
    expect(findOrphanFence(steps)).toEqual({ source: PAGE, stepIndex: 1 });
  });

  test("a page saved on the next step is NOT an orphan", () => {
    const steps: BuildSteps = [
      step({ text: `Here it is:\n${fenced(PAGE)}` }),
      step({ calls: [wrote("c1", "create")], results: [saved("c1", "p1")] }),
    ];
    expect(findOrphanFence(steps)).toBe(null);
  });

  test("a save that FAILED leaves the source orphaned", () => {
    // The compile-refusal and upstream-cut shapes both land here: the call was
    // made, nothing was stored, and the bytes are still only in the transcript.
    const steps: BuildSteps = [
      step({ text: fenced(PAGE) }),
      step({
        calls: [wrote("c1", "create")],
        results: [
          {
            toolCallId: "c1",
            toolName: "managePage",
            output: { error: "Page code failed to compile", code: "X" },
          },
        ],
      }),
    ];
    expect(findOrphanFence(steps)?.source).toBe(PAGE);
  });

  test("a save BEFORE the fence does not claim it", () => {
    // The post-review rewrite: the page exists, the builder emitted a new
    // version, and the run died. The fence is newer than the save.
    const steps: BuildSteps = [
      step({ calls: [wrote("c1", "create")], results: [saved("c1", "p1")] }),
      step({ text: `Reworking the header:\n${fenced(PAGE)}` }),
    ];
    expect(findOrphanFence(steps)?.source).toBe(PAGE);
  });

  test("a read after the fence claims nothing", () => {
    const steps: BuildSteps = [
      step({ text: fenced(PAGE) }),
      step({
        calls: [
          {
            toolCallId: "c1",
            toolName: "managePage",
            input: { action: "get" },
          },
        ],
        results: [saved("c1", "p1")],
      }),
    ];
    expect(findOrphanFence(steps)?.source).toBe(PAGE);
  });

  test("a `stage` call does not claim the fence it accompanies", () => {
    const steps: BuildSteps = [
      step({
        text: fenced(PAGE),
        calls: [
          {
            toolCallId: "c1",
            toolName: "managePage",
            input: { action: "stage" },
          },
        ],
        results: [
          {
            toolCallId: "c1",
            toolName: "managePage",
            output: { staged: true },
          },
        ],
      }),
    ];
    expect(findOrphanFence(steps)?.source).toBe(PAGE);
  });

  test("a truncated fence is not a page", () => {
    const steps: BuildSteps = [step({ text: `\`\`\`vue\n${PAGE}` })];
    expect(findOrphanFence(steps)).toBe(null);
  });

  test("a run that wrote no code has nothing to rescue", () => {
    const steps: BuildSteps = [
      step({ text: "I could not reach the data." }),
      step({ calls: [wrote("c1", "update")], results: [saved("c1", "p1")] }),
    ];
    expect(findOrphanFence(steps)).toBe(null);
  });
});

describe("formatBuildResult — a rescued page", () => {
  const cutMidWrite = {
    finishReason: "other",
    text: "",
    steps: [step({ text: fenced(PAGE) })],
  };

  test("names the page and states nobody has reviewed it", () => {
    const result = formatBuildResult(cutMidWrite, {
      saved: true,
      pageId: "p9",
      url: "/pages/p9",
    });
    expect(result.pageId).toBe("p9");
    expect(result.url).toBe("/pages/p9");
    expect(result.reviewed).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.summary).toContain("recovered");
    // The whole point: the parent must not rebuild a page that now exists.
    expect(result.summary).toContain("Do NOT call buildPage again");
  });

  test("a rescue that failed says why, and names no page", () => {
    const result = formatBuildResult(cutMidWrite, {
      saved: false,
      reason: "it carries no heading to name it from",
    });
    expect(result.pageId).toBeUndefined();
    expect(result.summary).toContain("it carries no heading to name it from");
    expect(result.incomplete).toBe(true);
  });

  test("with nothing to rescue the existing markers are untouched", () => {
    const result = formatBuildResult({
      finishReason: "other",
      text: "",
      steps: [],
    });
    expect(result.summary).toContain("saved NO page");
    expect(result.summary).toContain("Call buildPage once more");
  });
});
