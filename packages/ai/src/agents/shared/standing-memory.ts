import type { StandingEpisodesResult } from "@fretik/shared/services/episodes/list-standing";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { GRAPH_HEADING } from "../../services/recall/verbatim";

/**
 * Rendering for `<standing_memory>` — the block a turn is shown without having
 * matched it.
 *
 * No model runs here. The summaries were already written by the distiller,
 * which has its own eval; a second pass over them would be a summary of
 * summaries, and every defect the generated digest produced in its first week
 * (a link direction stated backwards as fact, a third of its sections silently
 * dropped, sixteen lines lost to a wrong marker prefix, a block outliving the
 * rows it cited) is a defect only a generation step can have.
 */

/**
 * Whether the standing slot is served. Read at module load, same contract as
 * `RECALL_MODE`: it takes effect on the next restart, not the next turn.
 * Per-request, `/invoke` accepts `X-Standing-Mode`.
 *
 * `none` is the rollback, and it is now a pure off switch — there is nothing
 * left to keep in sync with it, because the block no longer suppresses
 * anything from `<active_memory>`.
 *
 * The third arm, `digest`, was deleted on 2026-09-11 after the A/B. Measured
 * over 8 cases x 10 repeats: the two questions no retrieval can answer went
 * from 3/10 and 6/10 without a block to 30/30 each with this one, and the
 * generated digest scored level rather than ahead — at the price of one LLM
 * call per team per refresh, five generation defects in its first week, and a
 * team-scoped artefact that could not see 11 of a reader's 18 recent episodes.
 */
export type StandingMode = "episodes" | "none";

export const isStandingMode = (raw: string): raw is StandingMode =>
  raw === "episodes" || raw === "none";

const envMode = process.env.STANDING_MODE ?? "";
export const STANDING_MODE: StandingMode = isStandingMode(envMode)
  ? envMode
  : "episodes";

/**
 * The prompt budget. Paid on every turn of every member, so it is a ceiling on
 * what the team is charged, not a belief about how much they did this month —
 * `visibleInWindow` is what tells the reader the block is a summary.
 *
 * Measured with the tokeniser `measure:tokens` uses rather than estimated.
 */
export const STANDING_MAX_TOKENS = 600;

/**
 * Enough of a summary to answer "où on en est ?" without a tool call, not
 * enough to be the episode. The A/B reports `tool-call-count` per arm: if the
 * answers are right but each costs an extra `searchKnowledge`, this is the
 * number to raise.
 */
export const STANDING_CLIP_CHARS = 150;

/**
 * What the slot says when retrieval answered this message instead.
 *
 * NOT `""` — an empty block renders as "Nothing recorded in the last few
 * weeks.", which would be false: the window is full, it is just not what this
 * turn should read. That exact lie is what `83aebef` was written to stop.
 */
export const STANDING_SUPERSEDED =
  "_Not shown for this message — `<active_memory>` below was retrieved for it and supersedes this block._";

/**
 * The standing block is a FALLBACK for a message retrieval cannot answer, not
 * a companion to one it can.
 *
 * The scaffold has said "when it disagrees with `<active_memory>`, the
 * retrieved block wins" since the layer shipped, and nothing enforced it. What
 * that bought, measured 2026-09-12 on `mr-broad` ("fais le point sur <named
 * company>"): 29/30 with the block cut, 9/30 with it, the same graph-supplied
 * link missing every time — while the failing runs spent 5-13 tool calls, so
 * the agent was retrieving, not idling. Probing the two blocks for that message
 * showed why they compete: they share NO episode, the standing block opens the
 * prompt with a fresh, tidy, complete-looking status, and the reply gets
 * composed from it.
 *
 * **The signal is the GRAPH section, not emptiness.** Gating on "the block came
 * back non-empty" was tried first and cost the two cases this layer exists for:
 * semantic search dredges the Nordwind contract up for "où on en est ?" often
 * enough (6 of 10 repeats) that the fallback kept standing down on questions
 * nothing had actually answered — `mr-contextless-status` 10/10 -> 4/10,
 * `-brief` 10/10 -> 5/10, with the judge passing every time and only the
 * "names 2 of 3 subjects" floor breaking. Presence is a noisy signal.
 *
 * The graph arm is not. Its anchors come from records NAMED in the message, so
 * the section exists exactly when the message named something — measured
 * 2026-09-12: present on every probe of "fais le point sur Nordwind GmbH",
 * absent on all four probes of "où on en est ?". Read out of the rendered text
 * rather than from a flag, because a graph section dropped under budget
 * pressure is one the agent never sees, and a block it cannot see must not
 * silence the one it can.
 */
export const standingBlockFor = (
  rendered: string | undefined,
  activeMemoryBlock: string | undefined,
): string | undefined =>
  (activeMemoryBlock ?? "").includes(GRAPH_HEADING)
    ? STANDING_SUPERSEDED
    : rendered;

const countTokens = (text: string): number => encode(text).length;

/** Clip on a word boundary — a half-word reads as a typo, not as a clip. */
const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

/**
 * One line per episode, ending in a real provenance id.
 *
 * `As of <date>` is the idiom `<active_memory>` already renders, so the two
 * blocks read the same way. The marker is the whole id: the agent dereferences
 * it with `searchKnowledge({ filters: { sourceTypes: ['episodes'],
 * sourceIds: [id] } })`, which is why the clip above can be short.
 */
export const renderStandingEpisodes = (
  result: StandingEpisodesResult,
): string => {
  // Empty only when the window is genuinely empty. Episodes the caps exclude
  // still exist, and the caller renders `""` as "nothing recorded in the last
  // few weeks" — a claim the agent repeats to the user. When there is
  // something and none of it fits, say so and point at the tool.
  if (result.items.length === 0 && result.visibleInWindow === 0) return "";

  const lines = result.items.map((item) => {
    // Rolling per-record digests are a different KIND of statement from a
    // decision — "this record has been busy" rather than "we agreed X" — and
    // an unlabelled mix of the two reads as one list of equals.
    const prefix = item.kind === "record_activity" ? "[activity] " : "";
    return `- As of ${isoDay(item.at)} — ${prefix}${item.title} : ${clip(item.summary, STANDING_CLIP_CHARS)} (episode:${item.id})`;
  });

  // Say what was left out rather than let the block read as the whole story —
  // the same reason `<memory_index>` collapses to counts past 80 files.
  //
  // Counted against what SURVIVES, not against what the query returned: the
  // budget trim below is the other way lines go missing, and measured on the
  // EVAL team it is the one that actually fires (10 rows in, 7 lines out).
  // Subtracting `items.length` there would have dropped three episodes in
  // silence — the block would read as the whole of the last 30 days while
  // being three short, which is the one thing a footer exists to prevent.
  const withFooter = (kept: string[]): string[] => {
    const hidden = result.visibleInWindow - kept.length;
    return hidden > 0
      ? [
          ...kept,
          `- +${hidden.toString()} more in the last 30 days — \`searchKnowledge({ filters: { sourceTypes: ['episodes'] } })\``,
        ]
      : kept;
  };

  // Drop the OLDEST first, and never mid-line: a marker cut in half hands the
  // agent a truncated id it will spend a tool call on for nothing — the trap
  // the verbatim block's size cap already documents. The footer is inside the
  // budget, not on top of it, or the block overshoots by exactly the line that
  // was supposed to account for the overshoot.
  while (
    lines.length > 1 &&
    countTokens(withFooter(lines).join("\n")) > STANDING_MAX_TOKENS
  )
    lines.pop();

  return withFooter(lines).join("\n");
};
