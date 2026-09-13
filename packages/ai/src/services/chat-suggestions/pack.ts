import type { SuggestionSources } from "./sources";

/**
 * The context the suggestion writer reads, rendered deterministically.
 *
 * Pure: no I/O, no clock of its own. That is what makes the fingerprint below
 * trustworthy and the whole thing testable without a database.
 *
 * Every line ends in the id it came from (`episode:<uuid>`,
 * `conversation:<uuid>`, …) because provenance is the only defence this
 * feature has against an invented suggestion: the parser drops any draft
 * citing an id that was not offered here, so a hallucinated client name has
 * nothing to hang on.
 */

/** ~3k tokens. The reader waits behind this on a cold start. */
const MAX_PACK_CHARS = 12_000;
/** Enough of an episode to act on, not enough to be the episode. */
const EPISODE_CLIP = 280;
/** A memory file is prose the user wrote; the head of it carries the point. */
const MEMORY_CLIP = 300;

export interface SuggestionPack {
  /** What the model reads. */
  text: string;
  /**
   * Fingerprint of everything except the date line — so an idle workspace
   * produces the same hash tomorrow and costs no LLM call, while a new
   * document, a finished run or a fresh episode changes it.
   */
  inputHash: string;
  /** Every id the pack offered. The parser's allow-list. */
  sourceIds: Set<string>;
  /**
   * Nothing to personalise from. The caller returns the static starter cards
   * instead of paying for a generic answer.
   */
  isCold: boolean;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
};

const isoDay = (at: Date): string => at.toISOString().slice(0, 10);

const section = (heading: string, lines: string[]): string[] =>
  lines.length === 0 ? [] : [`## ${heading}`, ...lines, ""];

export const renderSuggestionPack = (
  sources: SuggestionSources,
  options: { language: string; now: Date },
): SuggestionPack => {
  const sourceIds = new Set<string>();
  const remember = (id: string): string => {
    sourceIds.add(id);
    return id;
  };

  const episodeLines = sources.episodes.map((episode) => {
    const prefix = episode.kind === "record_activity" ? "[activity] " : "";
    return `- ${isoDay(episode.at)} — ${prefix}${episode.title}: ${clip(episode.summary, EPISODE_CLIP)} (${remember(`episode:${episode.id}`)})`;
  });

  const conversationLines = sources.conversations.map((conversation) => {
    const flags = [
      conversation.unread ? "unread" : null,
      conversation.actionRequired ? "you were mentioned" : null,
    ]
      .filter((flag): flag is string => flag !== null)
      .join(", ");
    const suffix = flags.length > 0 ? ` [${flags}]` : "";
    return `- ${isoDay(conversation.updatedAt)} — ${conversation.title}${suffix} (${remember(`conversation:${conversation.id}`)})`;
  });

  // Memory lines carry an id like everything else. Measured 2026-09-13: a
  // suggestion built on a team convention ("relance fournisseur: 7-day
  // deadline, contract reference in copy") is one of the best this produces,
  // and without an id to cite the model invented one and the card was dropped
  // by the provenance gate.
  const memoryLines = sources.memories.map(
    (memory) =>
      `- [${memory.scope}] ${memory.path}: ${clip(memory.content, MEMORY_CLIP)} (${remember(`memory:${memory.scope}/${memory.path}`)})`,
  );

  const attentionLines = sources.attention.map(
    (item) =>
      `- ${item.kind === "approval" ? "waiting for approval" : "failed"}: ${item.title}, ${isoDay(item.at)} (${remember(`run:${item.id}`)})`,
  );

  // The journal repeats itself by nature (eight uploads into one folder), and
  // eight identical lines would read as eight different things to suggest.
  //
  // Each surviving line carries an id for the same reason memory lines do:
  // measured 2026-09-13, a suggestion about a record created yesterday had
  // nothing to cite and was dropped by the provenance gate as if invented.
  const seenActivity = new Set<string>();
  const activityLines = sources.activity.flatMap((item) => {
    const label = `${item.type}|${item.title}`;
    if (item.title.length === 0 || seenActivity.has(label)) return [];
    seenActivity.add(label);
    const actor = item.actorName ? ` by ${item.actorName}` : "";
    return [
      `- ${isoDay(item.at)} — ${item.type}: ${item.title}${actor} (${remember(`event:${item.id}`)})`,
    ];
  });

  const capabilityLines = sources.capabilities.map((capability) => {
    const description = capability.description
      ? `: ${clip(capability.description, 120)}`
      : "";
    return `- ${capability.kind} "${capability.name}"${description} (${remember(`${capability.kind}:${capability.id}`)})`;
  });

  const resolvedLines = sources.resolvedLabels.map(
    (resolved) => `- ${resolved.status}: ${resolved.label}`,
  );

  const body = [
    ...section("Recent episodes", episodeLines),
    ...section("Recent conversations", conversationLines),
    ...section("What this person keeps in memory", memoryLines),
    ...section("Waiting on this person", attentionLines),
    ...section("Recent workspace activity", activityLines),
    ...section("Workflows and pages the team already has", capabilityLines),
    ...section("Already suggested — do not repeat", resolvedLines),
  ]
    .join("\n")
    .trimEnd();

  const clipped =
    body.length > MAX_PACK_CHARS ? body.slice(0, MAX_PACK_CHARS) : body;

  // The day is IN the hash but the date line is not in the hashed text: the
  // pack must go stale once a day even when the workspace is idle (a "prepare
  // Monday's report" suggestion ages badly), while re-rendering the same day
  // must be free.
  const inputHash = new Bun.CryptoHasher("sha256")
    .update(`${clipped}\n@${isoDay(options.now)}`)
    .digest("hex");

  const header = [
    `Today: ${options.now.toISOString().slice(0, 10)} (${options.now.toLocaleDateString("en-US", { weekday: "long" })}).`,
    `Write in this language: ${options.language}.`,
    "",
  ].join("\n");

  return {
    text: `${header}${clipped}`,
    inputHash,
    sourceIds,
    // Capabilities and activity alone are not personalisation — a brand-new
    // team has both and nothing to say about either. What makes a suggestion
    // worth generating is a trace of this person's own work.
    isCold:
      sources.episodes.length === 0 &&
      sources.conversations.length === 0 &&
      sources.memories.length === 0,
  };
};
