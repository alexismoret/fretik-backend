import { describe, expect, test } from "bun:test";
import { parseSuggestions } from "../../../../src/services/chat-suggestions/parse";

/**
 * The gate between what a model said and what a person is shown.
 *
 * The rule this file exists for is the `sourceIds` one: a suggestion citing an
 * id that was never in the context is what an invented client, run or document
 * looks like from here, and it is dropped rather than displayed. The prompt
 * asks for the same thing; the prompt is not what enforces it.
 */

const ALLOWED = new Set([
  "episode:11111111-1111-1111-1111-111111111111",
  "conversation:22222222-2222-2222-2222-222222222222",
]);

const draft = (over: Record<string, unknown> = {}) => ({
  kind: "follow_up",
  label: "Follow up on the Meridian contract",
  prompt: "Draft the follow-up email about the Meridian penalty clause.",
  reason: "The clause was left open in Monday's conversation.",
  sourceIds: ["episode:11111111-1111-1111-1111-111111111111"],
  ...over,
});

const answer = (suggestions: unknown[]): string =>
  JSON.stringify({ suggestions });

describe("parseSuggestions — provenance gate", () => {
  test("keeps a suggestion whose ids were all offered", () => {
    const kept = parseSuggestions(answer([draft()]), ALLOWED);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe("Follow up on the Meridian contract");
  });

  test("drops one citing an id the context never contained", () => {
    const kept = parseSuggestions(
      answer([
        draft({ sourceIds: ["episode:00000000-0000-0000-0000-000000000000"] }),
      ]),
      ALLOWED,
    );

    expect(kept).toHaveLength(0);
  });

  test("forgives a bare id when exactly one offered id can mean it", () => {
    // Measured 2026-09-13: gpt-oss-20b cited `019fc79b-…` where the pack wrote
    // `episode:019fc79b-…`, on every draft. The citation is still checked; only
    // its spelling is forgiven.
    const kept = parseSuggestions(
      answer([draft({ sourceIds: ["11111111-1111-1111-1111-111111111111"] })]),
      ALLOWED,
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.sourceIds).toEqual([
      "episode:11111111-1111-1111-1111-111111111111",
    ]);
  });

  test("still drops a bare id nothing offered", () => {
    expect(
      parseSuggestions(
        answer([
          draft({ sourceIds: ["99999999-9999-9999-9999-999999999999"] }),
        ]),
        ALLOWED,
      ),
    ).toHaveLength(0);
  });

  test("drops one citing nothing at all, except a capability", () => {
    expect(
      parseSuggestions(answer([draft({ sourceIds: [] })]), ALLOWED),
    ).toHaveLength(0);

    const capability = parseSuggestions(
      answer([
        draft({
          kind: "capability",
          label: "Run the weekly report",
          sourceIds: [],
        }),
      ]),
      ALLOWED,
    );
    expect(capability).toHaveLength(1);
  });
});

describe("parseSuggestions — shape of a batch", () => {
  test("reads JSON the model wrapped in a markdown fence", () => {
    const fenced = `Here you go:\n\`\`\`json\n${answer([draft()])}\n\`\`\``;

    expect(parseSuggestions(fenced, ALLOWED)).toHaveLength(1);
  });

  test("caps a generous answer at six rather than dropping it", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      draft({
        kind: ["pending", "follow_up", "periodic", "insight", "capability"][
          index % 5
        ],
        label: `Suggestion ${String(index)}`,
      }),
    );

    expect(parseSuggestions(answer(many), ALLOWED)).toHaveLength(6);
  });

  test("one malformed entry costs that card only", () => {
    const kept = parseSuggestions(
      answer([
        draft({ prompt: "" }), // nothing to send — unusable
        draft({ kind: "insight", label: "Look at the margin trend" }),
      ]),
      ALLOWED,
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe("Look at the margin trend");
  });

  test("an over-long label or reason is clipped, never dropped", () => {
    // Measured against the real model 2026-09-13: five drafts of five carried
    // a reason longer than the prompt asks for. Rejecting on length emptied
    // the batch, which is a screen lost to a style rule.
    const kept = parseSuggestions(
      answer([
        draft({
          label: `Follow up ${"x".repeat(120)}`,
          reason: `Because ${"y".repeat(300)}`,
        }),
      ]),
      ALLOWED,
    );

    expect(kept).toHaveLength(1);
    expect(kept[0]?.label.length).toBeLessThanOrEqual(80);
    expect(kept[0]?.reason.length).toBeLessThanOrEqual(160);
    expect(kept[0]?.label.endsWith("…")).toBe(true);
  });

  test("lets no single kind take more than two slots", () => {
    const five = Array.from({ length: 5 }, (_, index) =>
      draft({ label: `Follow up ${String(index)}` }),
    );

    const kept = parseSuggestions(answer(five), ALLOWED);
    expect(kept.filter((item) => item.kind === "follow_up")).toHaveLength(2);
  });

  test("puts what waits on the person before what merely interests them", () => {
    const kept = parseSuggestions(
      answer([
        draft({ kind: "insight", label: "Look at the margin trend" }),
        draft({ kind: "pending", label: "Approve the pending run" }),
      ]),
      ALLOWED,
    );

    expect(kept[0]?.kind).toBe("pending");
  });

  test("drops a repeat of a label it already kept", () => {
    const kept = parseSuggestions(
      answer([draft(), draft({ kind: "insight" })]),
      ALLOWED,
    );

    expect(kept).toHaveLength(1);
  });

  test("drops an entry with an empty label or prompt", () => {
    expect(
      parseSuggestions(answer([draft({ label: "  " })]), ALLOWED),
    ).toHaveLength(0);
    expect(
      parseSuggestions(answer([draft({ prompt: "" })]), ALLOWED),
    ).toHaveLength(0);
  });
});

describe("parseSuggestions — a bad answer costs the batch, not the request", () => {
  test("prose instead of JSON yields nothing rather than throwing", () => {
    expect(parseSuggestions("I could not think of anything.", ALLOWED)).toEqual(
      [],
    );
  });

  test("an unknown kind drops that card rather than rendering a broken one", () => {
    expect(
      parseSuggestions(answer([draft({ kind: "brainstorm" })]), ALLOWED),
    ).toEqual([]);
  });

  test("an answer with no suggestions key yields nothing", () => {
    expect(parseSuggestions(JSON.stringify({ items: [] }), ALLOWED)).toEqual(
      [],
    );
  });
});
