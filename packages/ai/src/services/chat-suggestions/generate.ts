import type { SuggestionDraft } from "@fretik/shared/schemas/chat-suggestions";
import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModelForRoleProfile } from "../../lib/model-registry/resolve";
import { resolveModelForTeam } from "../../lib/model-registry/team-model";
import { withSlot } from "../../lib/rate-limit";
import { withNamedTrace } from "../../lib/trace-tool";
import type { SuggestionPack } from "./pack";
import { parseSuggestions } from "./parse";
import { buildSuggestionPrompt, SYSTEM_PROMPT } from "./prompt";

/**
 * One call: this reader's recent work in, four to six things worth asking out.
 *
 * Runs on the team's `recall` pick (`chat-suggestions` role — see
 * `ROLE_FUNCTION`). Same model and envelope as the memory judge because it is
 * the same job one moment earlier: read this person's memory, decide what
 * matters. Resolved per call, never at module load, so a quarantine or a
 * changed team setting takes effect on the next request.
 *
 * Soft-failing on purpose. A rejection, a timeout or an unparseable answer
 * returns `null` and the caller keeps serving the previous batch — nobody's
 * home screen breaks because a provider had a bad minute.
 */

const TEMPERATURE = 0.4;
/**
 * Six suggestions are ~600 tokens of JSON. The rest is headroom for the
 * `active-memory` envelope's reasoning, which counts against this budget on
 * some OpenRouter routes — the trap `conversation-title` documents, where too
 * tight a cap truncated the visible answer rather than the thinking.
 */
const MAX_OUTPUT_TOKENS = 4_000;
/** A person is watching a skeleton; past this, the screen is a lie. */
const TIMEOUT_MS = 25_000;
/** A burst of home-screen opens must not crowd out the turns themselves. */
const MAX_CONCURRENT = 5;
const HOLD_TIMEOUT_MS = 30_000;

export interface GeneratedSuggestions {
  items: SuggestionDraft[];
  modelKey: string;
  /**
   * What the call actually cost in tokens. Langfuse records this too; it is
   * returned because the probe's model bake-off has to price two candidates
   * against each other, and reasoning tokens — the half that decides the bill
   * here — are invisible in the answer.
   */
  usage: { inputTokens: number; outputTokens: number };
}

export const generateSuggestions = async (params: {
  teamId: string;
  userId: string;
  pack: SuggestionPack;
  /**
   * Force one registry profile instead of honouring the team's pick. For the
   * probe script only — the same eval-only override `resolveMemoryModel`
   * carries, and for the same reason: comparing two models on one workspace
   * must not mean editing a binding between runs.
   */
  profileOverride?: string;
}): Promise<GeneratedSuggestions | null> => {
  const { teamId, userId, pack } = params;

  try {
    return await withNamedTrace(
      "chat-suggestions",
      {
        userId,
        tags: [`team:${teamId}`],
        metadata: { teamId, inputHash: pack.inputHash },
      },
      async () => {
        const { model, profile } = params.profileOverride
          ? resolveModelForRoleProfile(
              "chat-suggestions",
              params.profileOverride,
            )
          : await resolveModelForTeam("chat-suggestions", teamId);
        const { text, finishReason, usage } = await withSlot(
          "openrouter:chat-suggestions",
          MAX_CONCURRENT,
          HOLD_TIMEOUT_MS,
          () =>
            generateText({
              model,
              instructions: SYSTEM_PROMPT,
              prompt: buildSuggestionPrompt(pack),
              temperature: TEMPERATURE,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
              abortSignal: AbortSignal.timeout(TIMEOUT_MS),
              telemetry: telemetryFor("chat-suggestions"),
            }),
        );
        if (finishReason === "length") {
          // The JSON below will not parse, so this pass writes nothing. Loud,
          // because a silent empty batch looks exactly like "nothing to say".
          console.warn(
            `[chat-suggestions] output truncated at ${MAX_OUTPUT_TOKENS.toString()} tokens (finishReason=length)`,
          );
        }
        return {
          items: parseSuggestions(text, pack.sourceIds),
          modelKey: profile.key,
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
          },
        };
      },
    );
  } catch (error) {
    console.warn(
      "[chat-suggestions] generation failed, keeping the previous batch:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
};
