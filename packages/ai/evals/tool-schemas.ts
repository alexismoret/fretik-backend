/**
 * Tool input-schema map for the eval harness — the mechanical
 * `tool-call-validity` signal (BFCL-AST analogue, on OUR tools).
 *
 * Builds `{ registryName → inputSchema }` from the SAME factories the
 * chatbot registers (`buildCoreTools` / `buildDomainTools`), so the
 * names match the `toolName`s observed on the SSE stream and the
 * schemas can never drift from production. `dispatchAgent` and `buildPage`
 * import their schemas directly (their factories need a built agent set; the
 * schemas are hoisted precisely for this consumer).
 *
 * Deliberately does NOT import `src/agents/chatbot/index.ts` — that
 * module builds full agent sets at init. The tool factories alone are
 * ctx-free and cheap.
 */

import { buildCoreTools, buildDomainTools } from "../src/agents/chatbot/tools";
import { buildPageInputSchema } from "../src/tools/build-page";
import { dispatchAgentInputSchema } from "../src/tools/dispatch-agent";
import type { ToolCallTrace } from "./types";

/**
 * Minimal runtime shape of a Zod schema. The AI SDK types
 * `inputSchema` as a flexible schema union, but every chatbot tool
 * defines it with `z.object(...)` — narrow at runtime instead of
 * casting.
 */
interface ZodLike {
  safeParse: (input: unknown) => { success: boolean; error?: unknown };
}

const isZodLike = (v: unknown): v is ZodLike => {
  if (typeof v !== "object" || v === null) return false;
  if (!("safeParse" in v)) return false;
  return typeof v.safeParse === "function";
};

let schemaMap: Map<string, ZodLike> | undefined;

const buildSchemaMap = (): Map<string, ZodLike> => {
  const map = new Map<string, ZodLike>();
  // The PARENT's tools: this validates the calls observed on its stream. A
  // build's own calls run inside `buildPage`'s execute and never reach this
  // signal.
  const domainTools = buildDomainTools();
  const register = (tools: Record<string, unknown>): void => {
    for (const [name, tool] of Object.entries(tools)) {
      if (typeof tool !== "object" || tool === null) continue;
      if (!("inputSchema" in tool)) continue;
      const schema: unknown = tool.inputSchema;
      if (isZodLike(schema)) map.set(name, schema);
    }
  };
  register(buildCoreTools(domainTools));
  register(domainTools);
  map.set("dispatchAgent", dispatchAgentInputSchema);
  // Same reason as `dispatchAgent`: its factory needs a built agent set, so
  // the schema is hoisted for this consumer.
  map.set("buildPage", buildPageInputSchema);
  return map;
};

const getSchemaMap = (): Map<string, ZodLike> => {
  schemaMap ??= buildSchemaMap();
  return schemaMap;
};

/**
 * Mechanical validity of the tool calls observed in one turn.
 *
 * - `total`/`valid` count only calls whose tool has a known schema —
 *   the validity ratio is `valid / total`.
 * - `unknown` counts calls whose name is not in the map (registry
 *   drift, or the SSE stream dropped the input frame). NOT counted as
 *   invalid: an unknown name is a harness gap, not a model failure.
 * - `failures` carries compact `name: issue` strings for the score
 *   comment (bounded — the first few are enough to debug).
 */
export interface ToolCallValiditySummary {
  total: number;
  valid: number;
  unknown: number;
  failures: string[];
}

const MAX_FAILURE_DETAILS = 5;

const describeFailure = (name: string, error: unknown): string => {
  const text =
    error instanceof Error ? error.message : JSON.stringify(error) || "";
  return `${name}: ${text.slice(0, 300)}`;
};

export const validateToolCalls = (
  toolCalls: ToolCallTrace[],
): ToolCallValiditySummary => {
  const map = getSchemaMap();
  const summary: ToolCallValiditySummary = {
    total: 0,
    valid: 0,
    unknown: 0,
    failures: [],
  };
  for (const call of toolCalls) {
    const schema = map.get(call.name);
    if (!schema) {
      summary.unknown++;
      continue;
    }
    summary.total++;
    const result = schema.safeParse(call.input);
    if (result.success) {
      summary.valid++;
    } else if (summary.failures.length < MAX_FAILURE_DETAILS) {
      summary.failures.push(describeFailure(call.name, result.error));
    }
  }
  return summary;
};
