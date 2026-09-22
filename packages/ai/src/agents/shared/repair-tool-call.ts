import { isRecord } from "@fretik/shared/external-apps/json-access";
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
 * One-shot LLM repair for a malformed tool call — a SHAPE fix, never a FACT
 * fix. The workflow's 4.32M-token incident ended a step on
 * `AI_InvalidToolInputError` (the model emitted `{}` for `python`); the repair
 * exists so a call with a wrong type or a misspelt enum is corrected instead
 * of coming back to the model as an error it has to re-emit.
 *
 * What it must NOT do is invent. Measured in prod (2026-09-14, 16 repairs in
 * one turn; 2026-09-09, 725 in one trace): an upstream host answered a 502
 * mid-stream, the SDK finalised the step with a tool call whose input was
 * EMPTY, and the repairer — given only the schema and that empty input — wrote
 * `{ action: "list" }`, which was then executed as if the model had asked for
 * it. The model saw a result it never requested, concluded it was looping, and
 * looped for real. The same shape a week earlier: a call without its
 * `providerKey` came back with one the repairer had made up.
 *
 * So the rule is `repairableInput`: no input, an unparseable input (a cut,
 * not a mis-shape), or a missing REQUIRED top-level key means the call cannot
 * be completed from what was said — return null. The SDK then surfaces the
 * original error to the model as a `tool-error` part and the loop continues;
 * nothing is discarded. Only a call that names every required key but gets a
 * shape wrong reaches the model.
 *
 * Scope: `InvalidToolInputError` only. `NoSuchToolError` (wrong tool NAME)
 * can't be fixed by rewriting args. The body reads only `toolCall.toolName` /
 * `inputSchema` / `error`, so it is fully tool-agnostic: generic over the tool
 * set and wired on the workflow, chatbot, and sub-agents.
 */
const REPAIR_TIMEOUT_MS = 10_000;

/**
 * `caption` is injected on every chatbot tool and defaulted by `.catch("")`,
 * so its absence never failed validation and never needs the model to know
 * anything — the one required key a repair may fill in on its own.
 */
const IMPLICIT_KEYS = new Set(["caption"]);

/** The top-level keys a JSON schema declares required, when it declares any. */
const requiredKeysOf = (schema: unknown): string[] => {
  if (!isRecord(schema) || !Array.isArray(schema.required)) return [];
  return schema.required.filter(
    (key): key is string => typeof key === "string",
  );
};

/**
 * The parsed input when a repair can be attempted, null when it cannot.
 * Exported for its test: this predicate IS the guarantee that the repairer
 * never speaks for the model.
 */
export const repairableInput = (
  raw: string,
  schema: unknown,
): Record<string, unknown> | null => {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "{}") return null;
  const parsed = parseLlmJsonObject(trimmed);
  if (!isRecord(parsed)) return null;
  const missing = requiredKeysOf(schema).filter(
    (key) => !IMPLICIT_KEYS.has(key) && !(key in parsed),
  );
  return missing.length === 0 ? parsed : null;
};

export const llmRepairToolCall = <
  TTools extends ToolSet,
>(): ToolCallRepairFunction<TTools> => {
  return async ({ toolCall, inputSchema, error }) => {
    if (!InvalidToolInputError.isInstance(error)) return null;

    let schema: unknown;
    try {
      schema = await inputSchema({ toolName: toolCall.toolName });
    } catch {
      return null;
    }
    const present = repairableInput(toolCall.input, schema);
    if (present === null) return null;

    try {
      const { text } = await generateText({
        model: resolveModel("tool-repair").model,
        instructions:
          "Fix the tool-call arguments so they satisfy the JSON schema. Keep every value the caller gave; change only what the validation error names. Output ONLY the corrected JSON object — no prose, no code fences.",
        prompt: [
          `Tool: ${toolCall.toolName}`,
          `JSON schema: ${JSON.stringify(schema)}`,
          `Invalid arguments: ${JSON.stringify(present)}`,
          `Validation error: ${error.message}`,
        ].join("\n"),
        abortSignal: AbortSignal.timeout(REPAIR_TIMEOUT_MS),
        // A repair was INVISIBLE in Langfuse until this line. `telemetryFor`
        // sets `functionId`, and v7 files that under an attribute the exporter
        // does not carry — verified 2026-09-22 over 6 762 `gpt-oss-120b`
        // observations, not one holds an agent name. So every repair landed as
        // a `chat openai/gpt-oss-120b` generation indistinguishable from the
        // turn-continuation judge, which is the same model on the same bare
        // role inside the same trace: 1 327 such calls in a month, and no way
        // to say how many were repairs. `includeRuntimeContext` is v7's
        // replacement for `telemetry.metadata` (same mechanism as
        // `langfusePrompt` in `agent-builder.ts`) and puts the tool name on the
        // span, which makes repairs countable.
        //
        // The SERVING PROVIDER is deliberately absent: this function never sees
        // it. `ToolCallRepairFunction` is handed the tool call, the schema and
        // the error, and nothing about the response that produced them. Attach
        // the host at read time instead — the repair is nested in the turn, so
        // the generation immediately before it carries `servingProvider`.
        // Writing a guess here would be worse than writing nothing.
        runtimeContext: { repairedTool: toolCall.toolName },
        telemetry: telemetryFor("agent-tool-repair", { repairedTool: true }),
      });
      // The cheap model often wraps the JSON in prose or code fences — pull
      // the object out defensively (shared helper: first `{`…last `}` + a
      // one-shot quote repair). streamText re-validates against the tool's
      // full schema; a still-wrong repair degrades to the no-repair marker.
      const parsed = parseLlmJsonObject(text);
      if (!isRecord(parsed)) return null;
      return { ...toolCall, input: JSON.stringify(parsed) };
    } catch {
      return null;
    }
  };
};
