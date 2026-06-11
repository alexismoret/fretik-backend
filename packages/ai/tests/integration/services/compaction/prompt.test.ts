import { describe, expect, test } from "bun:test";
import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
} from "../../../../src/services/compaction/prompt";

describe("getCompactPrompt", () => {
  test("starts with the no-tools preamble and ends with the no-tools trailer", () => {
    const prompt = getCompactPrompt();
    expect(prompt.startsWith("CRITICAL: Respond with TEXT ONLY")).toBe(true);
    expect(
      prompt.endsWith(
        "Tool calls will be rejected and you will fail the task.",
      ),
    ).toBe(true);
  });

  test("contains all 9 CC sections", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("1. Primary Request and Intent");
    expect(prompt).toContain("2. Key Domain References");
    expect(prompt).toContain("3. Files and Document References");
    expect(prompt).toContain("4. Errors and fixes");
    expect(prompt).toContain("5. Problem Solving");
    expect(prompt).toContain("6. All user messages");
    expect(prompt).toContain("7. Pending Tasks");
    expect(prompt).toContain("8. Current Work");
    expect(prompt).toContain("9. Optional Next Step");
  });

  test("calls out the verbatim-preservation domain (paths + identifiers)", () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain("VERBATIM PRESERVATION");
    expect(prompt).toContain("outputs/persisted/");
    expect(prompt).toContain("attachments/");
    expect(prompt).toContain("drive/");
    // Identifier examples must stay industry-agnostic (core rule) —
    // generic business identifiers in, transport vocabulary out.
    expect(prompt).toContain("invoice numbers");
    expect(prompt).toContain("purchase order numbers");
    expect(prompt).not.toContain("CMR");
  });

  test("instructs the model to write the summary in the conversation language", () => {
    const prompt = getCompactPrompt();
    // Case-insensitive match — the prompt uses "SAME language" (caps)
    // for emphasis but the assertion shouldn't be tied to that styling.
    expect(prompt.toLowerCase()).toContain("same language as the conversation");
  });
});

describe("formatCompactSummary", () => {
  test("strips the <analysis> drafting scratchpad", () => {
    const raw =
      "<analysis>thinking out loud here</analysis>\n<summary>1. Primary Request: do X.</summary>";
    const out = formatCompactSummary(raw);
    expect(out).not.toContain("thinking out loud");
    expect(out).not.toContain("<analysis>");
  });

  test("unwraps <summary>...</summary> with a 'Summary:' header", () => {
    const raw = "<summary>1. Primary Request: do X.</summary>";
    const out = formatCompactSummary(raw);
    expect(out.startsWith("Summary:")).toBe(true);
    expect(out).toContain("1. Primary Request: do X.");
  });

  test("handles missing closing </summary> by taking everything to end-of-string", () => {
    const raw = "<analysis>x</analysis>\n<summary>truncated content here";
    const out = formatCompactSummary(raw);
    expect(out).toContain("truncated content here");
    expect(out).not.toContain("<summary>");
  });

  test("collapses runs of blank lines", () => {
    const raw = "<summary>line 1\n\n\n\n\nline 2</summary>";
    const out = formatCompactSummary(raw);
    expect(out).not.toMatch(/\n{3,}/);
  });

  test("returns input unchanged-shape when neither <analysis> nor <summary> is present", () => {
    const raw = "Just a plain summary with no envelope.";
    const out = formatCompactSummary(raw);
    expect(out).toBe("Just a plain summary with no envelope.");
  });
});

describe("getCompactUserSummaryMessage", () => {
  test("starts with the continuation preface and embeds the formatted summary", () => {
    const out = getCompactUserSummaryMessage(
      "<summary>1. Primary Request: do X.</summary>",
      "",
    );
    expect(out).toContain("session is being continued");
    expect(out).toContain("Summary:");
    expect(out).toContain("1. Primary Request: do X.");
  });

  test("appends the runtime-state block when provided", () => {
    const out = getCompactUserSummaryMessage(
      "<summary>...</summary>",
      "Active domain tools: listDocuments\nPending tasks: 1. step (in_progress)",
    );
    expect(out).toContain("Active domain tools: listDocuments");
    expect(out).toContain("Pending tasks: 1. step (in_progress)");
  });

  test("omits the runtime-state block when empty", () => {
    const out = getCompactUserSummaryMessage("<summary>...</summary>", "");
    expect(out).not.toContain("Active domain tools");
    expect(out).not.toContain("Pending tasks");
  });

  test("ends with a continue-from-where-it-left-off instruction", () => {
    const out = getCompactUserSummaryMessage("<summary>...</summary>", "");
    expect(out).toContain("Continue from where the conversation left off");
    expect(out).toContain("read()");
  });
});
