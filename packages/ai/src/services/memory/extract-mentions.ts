import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import { generateText } from "ai";
import { z } from "zod";
import { telemetryFor } from "../../lib/langfuse";
import { resolveMemoryModel } from "../../lib/model-registry/team-model";
import { withNamedTrace } from "../../lib/trace-tool";

/**
 * LLM mention extraction — the PRIMARY extractor of the async event→graph
 * resolver (P3). Given arbitrary free-form text, a utility-tier model lists
 * the distinct named things the text refers to; the caller (@fretik/jobs
 * memory-resolve worker) funnels those spans through the shared
 * `matchSpansToRecords` precision funnel. Robust where the n-gram dictionary
 * pass is blind: lowercase names, free formats, typos, any language.
 *
 * Relevance is enforced structurally, not only by the prompt: a mention
 * links ONLY if it matches an existing confirmed record, and the resolver's
 * final confidence is `min(matchConfidence, mentionConfidence)` — a vague
 * mention can never auto-link however exact its lexical match. The prompt's
 * job is generalist recall + HONEST confidence; the trust bands do the rest.
 *
 * Output handling mirrors `search/multi-query.ts` (cheap model + defensive
 * parse degrading to empty), never `Output.object`: the structured-output
 * path sends `response_format`, which under the role envelope's
 * `require_parameters: true` narrows the OpenRouter provider pool
 * (the documented empty-pool failure mode) — a hard route error on a
 * best-effort background pass is worse than an occasional parse fallback,
 * and the end state on a bad completion is the same empty list either way.
 * Model selection mirrors `recall/recall.ts`: `resolveModelForTeam`
 * honours the team's utility pick (C8b) with the code default as fallback.
 */

/**
 * Defensive ceiling, ~2× the largest caller-side input (the resolver caps
 * its JSON fallback at 4 000 chars; chat.turn previews are ≤ ~800). ~2-3k
 * tokens — trivial for the utility tier; the flagships never see this text.
 */
const MAX_TEXT_CHARS = 8_000;
const MAX_MENTIONS = 15;
/**
 * Sized for the SLOWEST model this role may be pointed at, not the fastest.
 *
 * The memory roles run in background workers and nightly crons — nothing here
 * is on a turn's hot path, so a ceiling costs nothing until it fires, and when
 * it fires it costs a permanent row (an episode, a link, a learned memory) that
 * is simply never written. The old 20 s was implicitly a gpt-oss number
 * (100-300 TPS): at 40 TPS with a 1 500-token reasoning budget this pass needs
 * ~45 s, so any slower model would have failed the CLOCK rather than the task —
 * the exact mistake that produced the July "deepseek is too slow" verdict.
 */
const EXTRACT_TIMEOUT_MS = 90_000;
const EXTRACT_TEMPERATURE = 0;
/** See `consolidate-episodes.ts`: sized so reasoning cannot starve the answer. */
const EXTRACT_MAX_OUTPUT_TOKENS = 12_000;

export interface ExtractedMention {
  /** The mention verbatim from the text. */
  label: string;
  /** Optional lowercase noun guessing the entity kind ("company", "person"). */
  collectionKeyHint?: string;
  /** 0..1 — how sure the mention denotes one distinct, identifiable entity. */
  confidence: number;
}

const mentionsOutputSchema = z.object({
  mentions: z.array(
    z.object({
      label: z.string().min(1),
      collectionKeyHint: z.string().optional(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

const SYSTEM_PROMPT = `Extract the mentions in the input text that denote specific, distinct entities — anything referred to by a proper name or unique identifier that could correspond to a tracked record. The text is free-form: any language, any casing, any domain, possibly casual.

Output strict JSON, nothing else:
{"mentions":[{"label":"...","collectionKeyHint":"...","confidence":0.0}]}

- label: the mention verbatim as written.
- collectionKeyHint: lowercase noun guessing the entity kind (e.g. "company", "person"); omit when unsure.
- confidence: 0..1 — how sure the mention denotes one identifiable entity. 1.0 for a proper name or code; ≤0.4 for vague references ("the client", "that file").
- Max ${MAX_MENTIONS.toString()} mentions, most salient first. Nothing qualifies → {"mentions":[]}.
- Precision over recall: skip generic nouns, dates, quantities, and small talk. An inflated confidence is worse than a low one.`;

/**
 * Pull the JSON object out of a completion that may wrap it in code fences
 * or stray prose. Returns `[]` on any parse/validation failure.
 */
const parseMentions = (raw: string): ExtractedMention[] => {
  const parsed = mentionsOutputSchema.safeParse(parseLlmJsonObject(raw));
  if (!parsed.success) return [];
  return parsed.data.mentions;
};

export const extractMentions = async (input: {
  text: string;
  teamId: string;
  /** Force a registry profile — EVAL/BENCH ONLY (model bake-off). */
  modelProfileKey?: string;
}): Promise<ExtractedMention[]> => {
  const text = input.text.trim().slice(0, MAX_TEXT_CHARS);
  if (text.length === 0) return [];

  // Called straight from the internal HTTP handler, so this is its own root
  // trace — name it, or it lands as `invoke_agent <model>` (see
  // `withNamedTrace`).
  const { text: raw } = await withNamedTrace(
    "memory-extract",
    { tags: [`team:${input.teamId}`], metadata: { teamId: input.teamId } },
    async () => {
      const { model } = await resolveMemoryModel(
        "memory-extract",
        input.teamId,
        input.modelProfileKey,
      );
      return generateText({
        model,
        instructions: SYSTEM_PROMPT,
        prompt: text,
        temperature: EXTRACT_TEMPERATURE,
        maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
        telemetry: telemetryFor("memory-extract"),
      });
    },
  );

  return parseMentions(raw).slice(0, MAX_MENTIONS);
};
