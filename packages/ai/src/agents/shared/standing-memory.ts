import type { StandingEpisodesResult } from "@fretik/shared/services/episodes/list-standing";
import { encode } from "gpt-tokenizer/encoding/o200k_base";

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
 * Which implementation serves the standing slot. Read at module load, same
 * contract as `RECALL_MODE`: it takes effect on the next restart, not the next
 * turn. Per-request, `/invoke` accepts `X-Standing-Mode`, which is how an A/B
 * runs both arms against one live service instead of one restart apart.
 *
 * `none` is the rollback — it replaces the former `TEAM_DIGEST_ENABLED=false`
 * and, like it, must cut the recall-side suppression too, or the rows the
 * block covers would be missing from every block at once.
 */
export type StandingMode = "digest" | "episodes" | "none";

export const isStandingMode = (raw: string): raw is StandingMode =>
  raw === "digest" || raw === "episodes" || raw === "none";

const envMode = process.env.STANDING_MODE ?? "";
export const STANDING_MODE: StandingMode = isStandingMode(envMode)
  ? envMode
  : "digest";

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
