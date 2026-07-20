import { parseLlmJsonObject } from "@fretik/shared/lib/llm-json";
import {
  generateText,
  InvalidToolInputError,
  type ToolCallRepairFunction,
  type ToolSet,
} from "ai";
import { telemetryFor } from "../../lib/langfuse";
import { resolveModel } from "../../lib/model-registry/resolve";

/**
 * One-shot LLM repair for a malformed tool call. The workflow's 4.32M-token
 * incident ended a step on `AI_InvalidToolInputError` (the model emitted `{}`
 * for `python`); without repair the whole step is discarded and re-generated.
 *
 * Scope: `InvalidToolInputError` only (bad args). `NoSuchToolError` (wrong
 * tool NAME) can't be fixed by rewriting args → return null, letting the
 * framework surface the error so the model picks a real tool next step.
 *
 * On success streamText re-parses the returned call against the tool schema;
 * if the repair is still invalid it degrades to the same invalid-tool-call
 * marker as no repair — never worse than today. The body reads only
 * `toolCall.toolName` / `inputSchema` / `error`, so it is fully tool-agnostic:
 * generic over the tool set and wired on the workflow, chatbot, and sub-agents.
 */
const REPAIR_TIMEOUT_MS = 10_000;

export const llmRepairToolCall = <
  TTools extends ToolSet,
>(): ToolCallRepairFunction<TTools> => {
  return async ({ toolCall, inputSchema, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;

    let schemaJson: string;
    try {
      schemaJson = JSON.stringify(
        await inputSchema({ toolName: toolCall.toolName }),
      );
    } catch {
      return null;
    }

    try {
      const { text } = await generateText({
        model: resolveModel("tool-repair").model,
        instructions:
          "Fix the tool-call arguments so they satisfy the JSON schema. Output ONLY the corrected JSON object — no prose, no code fences.",
        prompt: [
          `Tool: ${toolCall.toolName}`,
          `JSON schema: ${schemaJson}`,
          `Invalid arguments: ${toolCall.input}`,
          `Validation error: ${error.message}`,
        ].join("\n"),
        abortSignal: AbortSignal.timeout(REPAIR_TIMEOUT_MS),
        telemetry: telemetryFor("agent-tool-repair"),
      });
      // The cheap model often wraps the JSON in prose or code fences — pull
      // the object out defensively (shared helper: first `{`…last `}` + a
      // one-shot quote repair). streamText re-validates against the tool's
      // full schema; a still-wrong repair degrades to the no-repair marker.
      const parsed = parseLlmJsonObject(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      return { ...toolCall, input: JSON.stringify(parsed) };
    } catch {
      return null;
    }
  };
};
