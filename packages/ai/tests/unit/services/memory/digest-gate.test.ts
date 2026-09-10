import { describe, expect, test } from "bun:test";
import { gateDigest } from "../../../../src/services/memory/build-team-digest";

/**
 * The gate between a model's output and text served on every turn.
 *
 * This is the only place a fabricated line can be stopped. Downstream there is
 * no reader to catch it: the digest arrives in the prompt as established team
 * knowledge, with none of the "some entries may not bear on this" framing the
 * retrieved block carries. So the tests below are about what gets DROPPED, and
 * each one seeds a line that is plausible in every respect except its
 * provenance.
 */

const handles = new Map<string, string>([
  ["memory:M1", "memory:conventions/recap.md"],
  ["episode:E1", "episode:019f0000-0000-7000-8000-000000000001"],
  ["record:R1", "record:019f0000-0000-7000-8000-000000000002"],
]);

describe("provenance gate", () => {
  test("a line with a real handle survives, expanded to the real id", () => {
    const { content, dropped } = gateDigest(
      "## Conventions\nWeekly recap goes in a table (memory:M1)",
      handles,
    );
    expect(content).toContain("(memory:conventions/recap.md)");
    expect(content).not.toContain("M1");
    expect(dropped).toBe(0);
  });

  test("a line with an INVENTED handle is dropped whole", () => {
    // The failure this exists for: the model writes a confident, useful-looking
    // sentence and attaches a marker that resolves to nothing. Blanking just
    // the marker would leave the claim standing with no provenance at all.
    const { content, dropped } = gateDigest(
      "## Conventions\nInvoices are paid at 30 days (memory:M9)",
      handles,
    );
    expect(content).not.toContain("30 days");
    expect(dropped).toBe(1);
  });

  test("a line with NO marker is dropped", () => {
    const { content, dropped } = gateDigest(
      "## Key entities\nThe team works mostly with European suppliers",
      handles,
    );
    expect(content).not.toContain("European suppliers");
    expect(dropped).toBe(1);
  });

  test("headings and blank lines survive without provenance", () => {
    const { content } = gateDigest(
      "## Conventions\n\nWeekly recap goes in a table (memory:M1)",
      handles,
    );
    expect(content).toContain("## Conventions");
  });

  test("a heading with nothing under it is dropped", () => {
    // Observed on the first real run: the prompt asks for empty sections to be
    // omitted and the model emitted "## Open threads" anyway. A heading with no
    // claim under it spends budget on every turn to say nothing.
    const { content } = gateDigest(
      "## Conventions\nWeekly recap goes in a table (memory:M1)\n\n## Open threads\n",
      handles,
    );
    expect(content).toContain("## Conventions");
    expect(content).not.toContain("Open threads");
  });

  test("a section the gate empties is dropped with its heading", () => {
    // The other way a section goes empty: its only line was invented.
    const { content, dropped } = gateDigest(
      "## Conventions\nWeekly recap (memory:M1)\n\n## Current decisions\nWe signed it (episode:E9)",
      handles,
    );
    expect(dropped).toBe(1);
    expect(content).toContain("## Conventions");
    expect(content).not.toContain("Current decisions");
  });

  test("one invented line does not take the valid ones with it", () => {
    const { content, dropped } = gateDigest(
      [
        "## Current decisions",
        "As of 2026-06-28, Vega lead time is 24h (episode:E1)",
        "As of 2026-07-01, the contract was signed (episode:E7)",
        "Acme is the reference supplier (record:R1)",
      ].join("\n"),
      handles,
    );
    expect(content).toContain("24h");
    expect(content).toContain("Acme");
    expect(content).not.toContain("contract was signed");
    expect(dropped).toBe(1);
  });

  test("everything invented leaves nothing, which the caller treats as failure", () => {
    const { content, dropped } = gateDigest(
      "## Conventions\nSomething (memory:M4)\nSomething else (episode:E9)",
      handles,
    );
    // Only the heading can survive, and a digest of headings is not a digest —
    // `buildTeamDigest` keeps the previous one rather than serving this.
    expect(content.replace(/#.*$/gm, "").trim()).toBe("");
    expect(dropped).toBe(2);
  });
});

describe("budget trim", () => {
  test("trims on a line boundary, never inside a marker", () => {
    // A marker cut in half is worse than a missing line: it hands the agent a
    // truncated id it will spend a tool call on for nothing.
    const long = Array.from(
      { length: 400 },
      (_, i) => `Line ${i.toString()} about the team's work (memory:M1)`,
    ).join("\n");
    const { content } = gateDigest(long, handles);

    const openParens = (content.match(/\(memory:/g) ?? []).length;
    const wellFormed = (content.match(/\(memory:[^)\s]+\)/g) ?? []).length;
    expect(openParens).toBe(wellFormed);
    expect(content.endsWith(")")).toBe(true);
  });

  test("keeps the head of the digest, not the tail", () => {
    // Sections are ordered by usefulness (conventions first), so trimming from
    // the end drops the least load-bearing content.
    const long = Array.from(
      { length: 400 },
      (_, i) => `Line ${i.toString()} about the team's work (memory:M1)`,
    ).join("\n");
    const { content } = gateDigest(long, handles);
    expect(content.startsWith("Line 0 ")).toBe(true);
  });
});
