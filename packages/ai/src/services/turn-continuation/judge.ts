import { generateText } from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModel } from "../../lib/model-registry/resolve";

/**
 * One-shot classifier for the dead-final-step recovery (`handlers/chatbot.ts`):
 * a turn that did tool work and then finished `stop` with a SHORT final text
 * and no tool call is either (a) a legitimate brief answer, or (b) the
 * MiniMax "understanding-execution gap" — the model announces the next action
 * ("Let me check the existing records…") and emits EOS instead of the tool
 * call (prod zombies 2026-07-22/23). The two are indistinguishable by
 * heuristics alone, so this judge reads the final text and decides.
 *
 * Fail-open: any error / timeout returns `false` (no continuation) — the
 * safety net must never degrade a legitimate turn.
 */
const JUDGE_TIMEOUT_MS = 8_000;

const JUDGE_INSTRUCTIONS = [
  "You receive the last visible message of an assistant turn that ended without any tool call.",
  'Decide whether it ANNOUNCES an action the assistant was about to perform — "Let me check the existing records", "I\'ll now generate the file", a forward-looking lead-in with no result — or DELIVERS a result: an answer, a confirmation of finished work, or a question addressed to the user.',
  "Reply with exactly one word: INCOMPLETE (announces an action that never happened) or COMPLETE (delivers a result). When unsure, reply COMPLETE.",
].join("\n");

export const isAnnouncedActionStop = async (
  finalText: string,
): Promise<boolean> => {
  // An empty final step after tool work delivered nothing — dead by
  // definition, no judge needed.
  if (finalText.trim().length === 0) return true;
  try {
    const { text } = await generateText({
      model: resolveModel("tool-repair").model,
      instructions: JUDGE_INSTRUCTIONS,
      prompt: finalText,
      abortSignal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      telemetry: telemetryFor("turn-continuation-judge"),
    });
    return /\bINCOMPLETE\b/i.test(text);
  } catch {
    return false;
  }
};
