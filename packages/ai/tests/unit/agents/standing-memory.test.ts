import type { StandingEpisodesResult } from "@fretik/shared/services/episodes/list-standing";
import { describe, expect, test } from "bun:test";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import {
  isStandingMode,
  renderStandingEpisodes,
  STANDING_CLIP_CHARS,
  STANDING_MAX_TOKENS,
  STANDING_SUPERSEDED,
  standingBlockFor,
} from "../../../src/agents/shared/standing-memory";
import { GRAPH_HEADING } from "../../../src/services/recall/verbatim";

/**
 * The rendering of a block served on every turn.
 *
 * What these tests are really about is the failure modes the GENERATED digest
 * had, none of which a deterministic renderer can reproduce — except one: a
 * provenance marker cut in half by a size cap, which is a property of the
 * trimming, not of the generation. That one is pinned below.
 */

const at = (iso: string): Date => new Date(iso);

const result = (
  items: StandingEpisodesResult["items"],
  visibleInWindow = items.length,
): StandingEpisodesResult => ({ items, visibleInWindow });

const episode = (
  id: string,
  title: string,
  summary: string,
  kind: "conversation" | "consolidated" | "record_activity" = "conversation",
  when = "2026-09-08T10:00:00Z",
): StandingEpisodesResult["items"][number] => ({
  id,
  kind,
  title,
  summary,
  at: at(when),
});

describe("rendering", () => {
  test("one line per episode, dated, ending in a real id", () => {
    const text = renderStandingEpisodes(
      result([
        episode(
          "019f0000-0000-7000-8000-000000000001",
          "Contrat Nordwind 2027",
          "Remise de 8 % et minimum de 500 unités par trimestre.",
        ),
      ]),
    );
    expect(text).toBe(
      "- As of 2026-09-08 — Contrat Nordwind 2027 : Remise de 8 % et minimum de 500 unités par trimestre. (episode:019f0000-0000-7000-8000-000000000001)",
    );
  });

  test("nothing to say renders as empty, not as a heading", () => {
    // The caller turns "" into the block's placeholder. A heading over nothing
    // spends budget on every turn of every member to say nothing — which is
    // exactly what the generated digest did before its empty sections were
    // dropped.
    expect(renderStandingEpisodes(result([]))).toBe("");
  });

  test("something the caps excluded is still reported, not called nothing", () => {
    // No item survived the query's kind/age caps, but five episodes are in the
    // window. `""` here would be rendered as "nothing recorded in the last few
    // weeks" — a claim the agent repeats to the user, and a false one.
    const text = renderStandingEpisodes(result([], 5));
    expect(text).toBe(
      "- +5 more in the last 30 days — `searchKnowledge({ filters: { sourceTypes: ['episodes'] } })`",
    );
  });

  test("a rolling record digest is labelled, so it does not read as a decision", () => {
    const text = renderStandingEpisodes(
      result([
        episode(
          "019f0000-0000-7000-8000-000000000002",
          "Acme Corp",
          "12 événements cette semaine.",
          "record_activity",
        ),
      ]),
    );
    expect(text).toContain("[activity] Acme Corp");
  });

  test("a long summary is clipped on a word boundary", () => {
    // Distinct words, so a cut inside one is visible in the assertion below.
    const long = Array.from(
      { length: 60 },
      (_, i) => `mot${i.toString()}`,
    ).join(" ");
    const text = renderStandingEpisodes(
      result([episode("019f0000-0000-7000-8000-000000000003", "T", long)]),
    );
    const body = text.slice(
      text.indexOf(" : ") + 3,
      text.indexOf(" (episode:"),
    );
    expect(body.length).toBeLessThanOrEqual(STANDING_CLIP_CHARS + 1);
    expect(body.endsWith("…")).toBe(true);
    // The kept prefix ends at a real word end: what follows it in the original
    // is a space, never the rest of a word. A half-word reads as a typo.
    const kept = body.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(" ");
  });
});

describe("budget", () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    episode(
      `019f0000-0000-7000-8000-${i.toString().padStart(12, "0")}`,
      `Episode ${i.toString()}`,
      "Un résumé de taille ordinaire pour une décision d'équipe.",
      "conversation",
      // Newest first, as the query returns them.
      new Date(Date.UTC(2026, 8, 10) - i * 3_600_000).toISOString(),
    ),
  );

  test("drops the OLDEST lines, never cuts inside one", () => {
    const text = renderStandingEpisodes(result(many));
    const lines = text.split("\n");
    expect(lines.length).toBeLessThan(many.length);
    // The head survives — the newest is what "lately" means.
    expect(lines[0]).toContain("Episode 0");
    // Every surviving episode line still carries a WHOLE marker. A marker cut
    // in half is worse than a missing line: the agent spends a tool call on an
    // id that resolves to nothing. The last line is the footer, which is the
    // subject of the next test.
    for (const line of lines.slice(0, -1))
      expect(line).toMatch(/\(episode:[0-9a-f-]+\)$/);
  });

  test("a line dropped for BUDGET is counted in the footer too", () => {
    // The defect this pins: counting what the QUERY returned rather than what
    // survived. On the EVAL team the query returned 10 rows and 7 lines fit,
    // and `visibleInWindow - items.length` is 0 — so the block said nothing
    // about three episodes it had silently dropped.
    const text = renderStandingEpisodes(result(many));
    const lines = text.split("\n");
    const footer = lines.at(-1) ?? "";
    const kept = lines.length - 1;
    expect(footer).toBe(
      `- +${(many.length - kept).toString()} more in the last 30 days — \`searchKnowledge({ filters: { sourceTypes: ['episodes'] } })\``,
    );
    // …and the footer is INSIDE the budget, not on top of it.
    expect(encode(text).length).toBeLessThanOrEqual(STANDING_MAX_TOKENS);
  });

  test("says how much it left out, and only when it did", () => {
    const withHidden = renderStandingEpisodes(
      result(
        [episode("019f0000-0000-7000-8000-000000000004", "T", "S")],
        // The query saw more in the window than the caps returned.
        9,
      ),
    );
    expect(withHidden).toContain("+8 more in the last 30 days");
    expect(withHidden).toContain("searchKnowledge");

    const complete = renderStandingEpisodes(
      result([episode("019f0000-0000-7000-8000-000000000005", "T", "S")]),
    );
    expect(complete).not.toContain("more in the last 30 days");
  });
});

describe("the fallback rule", () => {
  const rendered = "- As of 2026-09-10 — T : S (episode:abc)";

  const graphBlock = `${GRAPH_HEADING}\n\n- Nordwind GmbH (record:x)\n`;

  test("serves the block when retrieval came back with nothing", () => {
    expect(standingBlockFor(rendered, undefined)).toBe(rendered);
    expect(standingBlockFor(rendered, "")).toBe(rendered);
    expect(standingBlockFor(rendered, "   \n ")).toBe(rendered);
  });

  test("stands down when the message named a record", () => {
    expect(standingBlockFor(rendered, graphBlock)).toBe(STANDING_SUPERSEDED);
  });

  test("a NON-EMPTY block is not the signal — presence was tried and cost two cases", () => {
    // Semantic search finds something for "où on en est ?" often enough that
    // gating on emptiness stood the fallback down on the very questions it
    // exists for: `mr-contextless-status` fell 10/10 -> 4/10. Only a named
    // record silences it.
    expect(standingBlockFor(rendered, "EPISODES:\n(episode:x)\n…")).toBe(
      rendered,
    );
    expect(standingBlockFor(rendered, "FACTS — team memory:\n…")).toBe(
      rendered,
    );
  });

  test("stands down LOUDLY — silence here reads as an empty window", () => {
    // The renderer turns `undefined` into "Nothing recorded in the last few
    // weeks.", which is false when the block was withheld rather than empty.
    // If this ever becomes `undefined`, the agent is told the team did nothing
    // this month.
    expect(standingBlockFor(rendered, graphBlock)).not.toBeUndefined();
    expect(STANDING_SUPERSEDED).toContain("<active_memory>");
  });

  test("an empty window stays empty — the rule adds nothing", () => {
    expect(standingBlockFor(undefined, undefined)).toBeUndefined();
  });
});

describe("mode parsing", () => {
  test("accepts the two modes and nothing else", () => {
    expect(isStandingMode("episodes")).toBe(true);
    expect(isStandingMode("none")).toBe(true);
    // `/invoke` answers 400 on anything else rather than silently serving a
    // default. `digest` was the third arm until 2026-09-11 and must now be
    // REFUSED, not quietly treated as the default: an operator rolling back to
    // a mode that no longer exists has to be told, not served something else.
    expect(isStandingMode("digest")).toBe(false);
    expect(isStandingMode("true")).toBe(false);
    expect(isStandingMode("")).toBe(false);
  });
});
