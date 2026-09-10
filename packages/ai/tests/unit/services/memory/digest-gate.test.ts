import type { DigestInputs } from "@fretik/shared/services/memory-digest/collect-inputs";
import { describe, expect, test } from "bun:test";
import {
  gateDigest,
  missingSections,
} from "../../../../src/services/memory/build-team-digest";

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

  test("a section the inputs called for and the output skipped is named", () => {
    // Measured at 1 in 10 on a real team: a 318-token digest holding
    // conventions and nothing else, well formed, in budget, every marker
    // resolving — on inputs that carried entities AND a current decision.
    // `finishReason` was not "length", so nothing upstream caught it.
    //
    // A section that never appears is indistinguishable from a team that has
    // nothing to say there, and it would be served that way for a day. The
    // caller keeps the previous digest instead.
    const inputs: DigestInputs = {
      conventions: [{ path: "team/x.md", content: "…", updatedAt: new Date() }],
      entities: [
        {
          id: "r1",
          label: "Acme",
          collectionKey: "orgs",
          links: [],
          updatedAt: new Date(),
        },
      ],
      decisions: [
        {
          id: "e1",
          title: "t",
          summary: "s",
          occurredTo: null,
          updatedAt: new Date(),
        },
      ],
      threads: [],
      fingerprint: "f",
    };

    expect(
      missingSections(
        inputs,
        "## Conventions — how this team works\n- a (memory:x)",
      ),
    ).toEqual(["## Key entities", "## Current decisions"]);

    // The shortened heading the model routinely writes still counts as written.
    expect(
      missingSections(
        inputs,
        "## Conventions\n- a\n\n## Key entities\n- b\n\n## Current decisions\n- c",
      ),
    ).toEqual([]);

    // A section with no input is not owed, so its absence is not a defect.
    expect(missingSections(inputs, "").includes("## Open threads")).toBe(false);
  });

  test("a long section pays for the budget, not the last section", () => {
    // The failure this exists for, measured at 2/10 on a real team: the entity
    // list is long, "Current decisions" comes last, and a trim that cuts from
    // the end deleted the decisions outright. Silent, because a section that
    // never appears looks exactly like a team that has none.
    const entities = Array.from(
      { length: 400 },
      (_, i) => `Entity ${i.toString()} works with the team (record:R1)`,
    );
    const { content } = gateDigest(
      [
        "## Key entities",
        ...entities,
        "## Current decisions",
        "As of 2026-09-08, the free-shipping threshold is 800 € (episode:E1)",
      ].join("\n"),
      handles,
    );
    expect(content).toContain("## Current decisions");
    expect(content).toContain("800 €");
    // And the section that paid is the one that could afford to.
    expect(content).toContain("## Key entities");
    expect(content).toContain("Entity 0 ");
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
