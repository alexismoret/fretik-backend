import { describe, expect, test } from "bun:test";
import type { SearchableToolRegistry } from "../../../src/agents/shared/chatbot-tool";
import { DynamicToolManager } from "../../../src/agents/shared/dynamic-tools";
import {
  wrapRuntimeContext,
  type AgentRuntimeContext,
} from "../../../src/agents/shared/runtime-context";
import { TaskManager } from "../../../src/agents/shared/task-manager";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { createSearchToolsTool } from "../../../src/tools/search-tools";

/**
 * Fixed domain registry used by all searchTools tests. Exercises the
 * parser's matching behaviour end-to-end: exact `select:` path,
 * multi-match, not-found, keyword search, and required `+term`
 * prefix filtering.
 */
const DOMAIN: SearchableToolRegistry = {
  listDocuments: {
    description:
      "List documents for the current team with optional filters and pagination.",
    searchHint:
      "search filter list team documents by type folder status filename",
    category: "domain",
  },
  listExtractions: {
    description:
      "List extractions for the current team with optional filters and pagination.",
    searchHint:
      "search filter list extractions by config status name browse batch",
    category: "domain",
  },
  getExtractionData: {
    description: "Read a single extraction by ID.",
    searchHint:
      "read extraction extracted_data json schema fields one specific id",
    category: "domain",
  },
  webFetch: {
    description: "Fetch a public URL as cleaned Markdown.",
    searchHint: "fetch extract read content specific url page markdown article",
    category: "domain",
  },
};

const buildCtx = (): {
  ctx: AgentRuntimeContext;
  manager: DynamicToolManager;
} => {
  const manager = new DynamicToolManager();
  const ctx: AgentRuntimeContext = {
    organizationId: "org-1",
    teamId: "team-1",
    dynamicToolManager: manager,
    taskManager: new TaskManager(),
    modelProfile: getProfileForRole("chat"),
  };
  return { ctx, manager };
};

/**
 * Shape of the `searchTools` execute payload that this test suite
 * observes. Kept as a local type so we don't need to reach into the
 * tool module's private return shape.
 */
interface SearchToolsResult {
  matches: string[];
  query: string;
  total_deferred_tools: number;
  notFound?: string[];
}

/**
 * Invoke the tool's execute function the same way the AI SDK does
 * at runtime — wraps the ctx so `getRuntimeContext` can recover it
 * without the brand check failing. Uses the real
 * `ToolExecutionOptions` signature derived from the execute
 * function itself so no type assertions are needed.
 */
const runSearchTools = async (
  input: { query: string; max_results?: number },
  ctx: AgentRuntimeContext,
): Promise<SearchToolsResult> => {
  const tool = createSearchToolsTool(DOMAIN);
  const execute = tool.execute;
  if (!execute) throw new Error("searchTools has no execute fn");
  type ExecOptions = Parameters<NonNullable<typeof tool.execute>>[1];
  const options: ExecOptions = {
    toolCallId: "call-1",
    messages: [],
    experimental_context: wrapRuntimeContext(ctx),
  };
  const result = await execute(input, options);
  // The tool returns a plain object matching SearchToolsResult in
  // every code path we exercise here; the runtime shape is an
  // invariant of `createSearchToolsTool`.
  if (typeof result !== "object" || result === null) {
    throw new Error(`searchTools returned non-object: ${String(result)}`);
  }
  const record = result as Record<string, unknown>;
  return {
    matches: record.matches as string[],
    query: record.query as string,
    total_deferred_tools: record.total_deferred_tools as number,
    notFound: record.notFound as string[] | undefined,
  };
};

describe("searchTools parser", () => {
  test("select:<exact name> activates that one tool", async () => {
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "select:listDocuments" }, ctx);
    expect(result.matches).toEqual(["listDocuments"]);
    expect(result.total_deferred_tools).toBe(Object.keys(DOMAIN).length);
    expect(manager.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("select:<a>,<b> activates both", async () => {
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools(
      { query: "select:listDocuments,listExtractions" },
      ctx,
    );
    expect(new Set(result.matches)).toEqual(
      new Set(["listDocuments", "listExtractions"]),
    );
    expect(new Set(manager.getSnapshot())).toEqual(
      new Set(["listDocuments", "listExtractions"]),
    );
  });

  test("select:<unknown> returns notFound without activating anything", async () => {
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "select:noSuchTool" }, ctx);
    expect(result.matches).toEqual([]);
    expect(result.notFound).toEqual(["noSuchTool"]);
    expect(manager.getSnapshot()).toEqual([]);
  });

  test("keyword search matches on searchHint tokens", async () => {
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "documents team" }, ctx);
    expect(result.matches).toContain("listDocuments");
    expect(manager.getSnapshot()).toContain("listDocuments");
  });

  test("`+term` required prefix filters candidates", async () => {
    const { ctx } = buildCtx();
    const result = await runSearchTools(
      { query: "+extraction schema fields" },
      ctx,
    );
    // Every match must contain the required 'extraction' term.
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches).toContain("getExtractionData");
  });

  test("bare tool name (no select: prefix) activates via the exact-match fast path", async () => {
    // Mirrors Claude Code's ToolSearchTool.ts:199-204 fast path. When the
    // model passes a glued camelCase name like "listDocuments" without the
    // select: prefix, the keyword tokenizer would normally fail (single
    // opaque term). The fast path short-circuits this by checking for a
    // direct registry hit before falling through to the scorer.
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "listDocuments" }, ctx);
    expect(result.matches).toEqual(["listDocuments"]);
    expect(manager.getSnapshot()).toEqual(["listDocuments"]);
  });

  test("fast path ignores whitespace around a bare tool name", async () => {
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "  listExtractions  " }, ctx);
    expect(result.matches).toEqual(["listExtractions"]);
    expect(manager.getSnapshot()).toEqual(["listExtractions"]);
  });

  test("fast path is case-sensitive — wrong case falls through to keyword search", async () => {
    // Registry keys are canonical camelCase; the fast path is a strict
    // `name in domainTools` check. A lower-cased variant like
    // "listdocuments" is a single opaque token that won't match any
    // parsed tool part either, so the scorer returns empty.
    const { ctx, manager } = buildCtx();
    const result = await runSearchTools({ query: "listdocuments" }, ctx);
    expect(result.matches).toEqual([]);
    expect(manager.getSnapshot()).toEqual([]);
  });

  test("select is idempotent — re-activating the same tool leaves state unchanged", async () => {
    const { ctx, manager } = buildCtx();
    await runSearchTools({ query: "select:listDocuments" }, ctx);
    await runSearchTools({ query: "select:listDocuments" }, ctx);
    expect(manager.getSnapshot()).toEqual(["listDocuments"]);
  });
});
