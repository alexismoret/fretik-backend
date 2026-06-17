import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { instrumentModel } from "../../lib/model-instrumentation";
import { cheapModelIdForTeam } from "../../lib/model-registry/team-model";
import { openrouter } from "../../lib/openrouter";
import { withSlot } from "../../lib/rate-limit";

/**
 * Generate a short, human-readable title for a conversation from its
 * first user message — the same affordance Claude / ChatGPT ship: the
 * sidebar shows a placeholder, then swaps in a real title once the
 * first turn lands.
 *
 * Runs on `CHEAP_MODEL` (`openai/gpt-oss-20b` via OpenRouter — the same
 * constant used by multi-query reformulation and compaction) in
 * `reasoning: { effort: "low" }`. Titling needs no multi-step
 * reasoning, so we cap the reasoning budget tight: gpt-oss-20b applies
 * a non-trivial budget by default and `maxOutputTokens` only bounds the
 * VISIBLE text, not the hidden reasoning tokens. See multi-query.ts for
 * the same rationale.
 *
 * Concurrency: routed through the shared `openrouter:cheap` semaphore so
 * a burst of new conversations can't blow OpenRouter's account-wide
 * limit for the cheap model.
 *
 * Failure policy: fully soft — any rejection, timeout, or empty output
 * returns `null` and the caller keeps the placeholder title. NEVER
 * throws (it runs inside a live chatbot turn and must not break it).
 */

const TITLE_TEMPERATURE = 0.3;
// `reasoning: { effort: "low" }` spends hidden reasoning tokens that
// count against this budget on some OpenRouter routes — too tight a cap
// truncates the VISIBLE title mid-word (observed: a 40-token cap cut
// "…prévus (Cou"). Give generous headroom; brevity is enforced by the
// prompt, not the token cap, so this won't inflate normal titles.
const TITLE_MAX_TOKENS = 256;
const TITLE_TIMEOUT_MS = 8_000;

const CHEAP_MODEL_MAX_CONCURRENT = Number(
  process.env.AI_CHEAP_MODEL_MAX_CONCURRENT ?? "20",
);
const CHEAP_MODEL_HOLD_TIMEOUT_MS = 30_000;

// Per-id memo of the instrumented title model under its own `effort: "low"`
// envelope. Keyed by the resolved model ID so a team's utility pick (C8b) gets
// its own instance without rebuilding it per call.
const titleModelById = new Map<string, ReturnType<typeof instrumentModel>>();
const titleModelFor = (modelId: string): ReturnType<typeof instrumentModel> => {
  const cached = titleModelById.get(modelId);
  if (cached) return cached;
  const model = instrumentModel(
    openrouter.chat(modelId, { reasoning: { effort: "low" } }),
  );
  titleModelById.set(modelId, model);
  return model;
};

const SYSTEM_PROMPT = `Generate a concise title for a conversation that opens with the message below.

The title is a short noun phrase naming the topic — like a thread name in a chat sidebar. Aim for 2 to 5 words. Never write a full sentence, never describe or restate the request, never list what the user asked for.

Match the language of the message. Preserve proper nouns, codes, and numbers exactly.

Respond with the title only: no quotes, no surrounding punctuation, no trailing period, no "Title:" prefix.`;

/**
 * Strip the decorations cheap models tend to add around a title: a
 * leading `Title:` label, wrapping quotes/backticks, and trailing
 * punctuation. Returns the FULL cleaned title — the sidebar and header
 * truncate it visually via CSS, so we persist it whole rather than
 * baking an ellipsis into the stored value.
 */
const cleanTitle = (raw: string): string => {
  let title = raw.trim().replace(/\s+/gu, " ");
  title = title.replace(/^title\s*[:\-–]\s*/iu, "");
  title = title.replace(/^["'`«»](.*)["'`«»]$/u, "$1").trim();
  title = title.replace(/[.,;:!?]+$/u, "").trim();
  return title;
};

export const generateConversationTitle = async (
  userMessage: string,
  teamId?: string,
): Promise<string | null> => {
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return null;

  const titleModel = titleModelFor(await cheapModelIdForTeam(teamId));

  let rawText: string;
  try {
    const { text } = await withSlot(
      "openrouter:cheap",
      CHEAP_MODEL_MAX_CONCURRENT,
      CHEAP_MODEL_HOLD_TIMEOUT_MS,
      () =>
        generateText({
          model: titleModel,
          system: SYSTEM_PROMPT,
          prompt: trimmed,
          temperature: TITLE_TEMPERATURE,
          maxOutputTokens: TITLE_MAX_TOKENS,
          abortSignal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
          experimental_telemetry: telemetryFor("conversation-title"),
        }),
    );
    rawText = text;
  } catch (err) {
    console.warn(
      "[conversation-title] generation failed, keeping placeholder:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const title = cleanTitle(rawText);
  return title.length > 0 ? title : null;
};
