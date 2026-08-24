import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildCoreTools,
  buildDomainTools,
} from "../../../src/agents/chatbot/tools";
import { dispatchAgentInputSchema } from "../../../src/tools/dispatch-agent";

/**
 * Every registered tool's input schema is converted to JSON Schema and shipped
 * to the model on the turns it is active. That conversion is the last piece of
 * our code an upstream sees, and it is the one place where a locally valid Zod
 * schema becomes an upstream-specific failure.
 *
 * Found the hard way (2026-08-09): `managePage` carried a self-referencing
 * `$defs` entry, because its value leaf was `z.lazy(() => … itself …)`. Three
 * upstreams of the same model, same prompt, n=3 each — DeepInfra and BaseTen
 * served it, and Together answered `400 — tool schema contains a circular
 * reference` to EVERY call. Nothing in the stack reported that as a schema
 * problem: it surfaced as a model that could not build a page.
 *
 * The registry is open by design (a team may bind any profile, and a profile
 * routes across its own upstream pool), so "it works on the provider we happen
 * to route to today" is not a property worth having. These invariants hold for
 * every tool, whichever model or upstream serves the turn.
 *
 * Enumeration mirrors `evals/tool-schemas.ts`: the tool FACTORIES are ctx-free
 * and cheap; `src/agents/chatbot/index.ts` is deliberately not imported (it
 * builds full agent sets at init).
 */

/**
 * What `@ai-sdk/provider-utils`'s `zod4Schema` passes. `reused: "inline"` is
 * the load-bearing one: it expands a schema reused across positions in place,
 * so the only thing that can still emit `$defs` is a genuine cycle.
 */
const SDK_CONVERSION = {
  target: "draft-7",
  io: "input",
  reused: "inline",
} as const;

interface ZodLike {
  safeParse: (input: unknown) => { success: boolean };
}

const isZodLike = (value: unknown): value is ZodLike =>
  typeof value === "object" &&
  value !== null &&
  "safeParse" in value &&
  typeof value.safeParse === "function";

const isZodType = (value: unknown): value is z.ZodType =>
  isZodLike(value) && "_zod" in value;

/**
 * `{ registryName → inputSchema }` for every tool schema that reaches a model.
 *
 * `managePage` is built twice: the parent agent gets the editing surface and
 * the page builder gets the authoring one (a wider `action` enum). They ship to
 * the same upstream pool, so a variant that never appears here is a variant
 * these invariants do not cover.
 */
const registeredSchemas = (): Map<string, z.ZodType> => {
  const map = new Map<string, z.ZodType>();
  const domainTools = buildDomainTools({ pageAuthoring: false });
  const authoringTools = buildDomainTools({ pageAuthoring: true });
  const register = (tools: Record<string, unknown>): void => {
    for (const [name, tool] of Object.entries(tools)) {
      if (typeof tool !== "object" || tool === null) continue;
      if (!("inputSchema" in tool)) continue;
      const schema: unknown = tool.inputSchema;
      if (isZodType(schema)) map.set(name, schema);
    }
  };
  register(buildCoreTools(domainTools));
  register(domainTools);
  const authoringManagePage = authoringTools.managePage.inputSchema;
  if (isZodType(authoringManagePage)) {
    map.set("managePage(authoring)", authoringManagePage);
  }
  map.set("dispatchAgent", dispatchAgentInputSchema);
  return map;
};

describe("tool input schemas — what every upstream has to accept", () => {
  const schemas = registeredSchemas();

  test("the registry is enumerable and non-trivial", () => {
    expect(schemas.size).toBeGreaterThan(20);
    expect(schemas.has("managePage")).toBe(true);
  });

  test("every schema converts to JSON Schema at all", () => {
    const failures: string[] = [];
    for (const [name, schema] of schemas) {
      try {
        z.toJSONSchema(schema, SDK_CONVERSION);
      } catch (error) {
        // A throw here is a boot-time crash in production, not a test nicety:
        // the SDK converts without `unrepresentable: "any"`.
        failures.push(`${name}: ${String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("no schema contains a cycle — Together rejects one with HTTP 400", () => {
    const cyclic: string[] = [];
    for (const [name, schema] of schemas) {
      const json = JSON.stringify(z.toJSONSchema(schema, SDK_CONVERSION));
      if (json.includes('"$ref"') || json.includes('"$defs"'))
        cyclic.push(name);
    }
    expect(cyclic).toEqual([]);
  });
});
