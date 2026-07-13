import { tool } from "ai";
import { z } from "zod";
import type {
  SearchableTool,
  SearchableToolRegistry,
} from "../agents/shared/chatbot-tool";
import { policyHiddenToolNames } from "../agents/shared/policy-tool-gate";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowMainHiddenToolNames } from "../agents/shared/workflow-tool-gate";

/**
 * Progressive Disclosure entry point.
 *
 * `searchTools` is a core tool — it is always loaded into the initial
 * `streamText()` call. It is the only mechanism the model has to
 * activate a domain tool whose full input schema is intentionally kept
 * out of the initial context to save tokens.
 *
 * The input shape and scoring rules mirror Claude Code's own
 * `ToolSearchTool` (see `claude-code/src/tools/ToolSearchTool/`). A
 * single `query` string supports two forms:
 *
 * - **Direct select**: `select:listDocuments` or
 *   `select:listDocuments,getDocumentContent` — exact names, comma
 *   separated. Unknown names are reported in `notFound` but the call
 *   does not fail so the model can retry with a different form.
 * - **Keyword search**: plain space-separated terms scored against
 *   each domain tool's name parts, `searchHint`, and `description`.
 *   A term prefixed with `+` is required (the tool must contain it) —
 *   remaining terms rank the candidate set.
 *
 * Scoring weights copied from Claude Code's implementation:
 *
 *   - name part exact match   : 10
 *   - name part partial match : 5
 *   - full-name fallback      : 3 (only when score is still 0)
 *   - searchHint match        : 4  (word-boundary)
 *   - description match       : 2  (word-boundary)
 *
 * Fretik deviation vs Claude Code: Anthropic's API supports a native
 * `defer_loading` + `tool_reference` block mechanism that lets the
 * server attach the matched tool schemas back into the model's
 * context. OpenRouter + the non-Anthropic models we run on top of it
 * do not. We substitute it with the Vercel AI SDK's `prepareStep`
 * callback which reads this tool's side-effect on
 * `ctx.dynamicToolManager` and adds the activated names to
 * `activeTools` on the next step. Net effect is the same — the model
 * sees the tools it asked for and nothing else.
 */

const DEFAULT_MAX_RESULTS = 5;

/**
 * Escape a string for safe inclusion inside a regular expression.
 * Same helper Claude Code uses under `utils/stringUtils.ts` — inlined
 * here to avoid pulling a tiny util into a shared lib.
 */
const escapeRegExp = (input: string): string =>
  input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface ParsedToolName {
  parts: string[];
  full: string;
}

/**
 * Split a tool name into lowercase searchable parts. Handles the
 * CamelCase names that Fretik uses (`listDocuments` →
 * `['list', 'documents']`) and underscore-separated MCP-style names.
 * Mirrors Claude Code's `parseToolName` but drops the MCP scoring
 * bonus since Fretik's chatbot has no MCP tools.
 */
const parseToolName = (name: string): ParsedToolName => {
  const parts = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  return { parts, full: parts.join(" ") };
};

/**
 * Pre-compile `\bterm\b` regexes once per search so scoring loops
 * don't rebuild them for every tool.
 */
const compileTermPatterns = (terms: readonly string[]): Map<string, RegExp> => {
  const patterns = new Map<string, RegExp>();
  for (const term of terms) {
    if (!patterns.has(term)) {
      patterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`));
    }
  }
  return patterns;
};

interface ScoredTool {
  name: string;
  score: number;
}

/**
 * Score a single candidate tool against the parsed query terms using
 * the Claude Code weighting described above.
 */
const scoreTool = (
  toolName: string,
  searchHint: string,
  description: string,
  allScoringTerms: readonly string[],
  termPatterns: Map<string, RegExp>,
): number => {
  const parsed = parseToolName(toolName);
  const descNormalized = description.toLowerCase();
  const hintNormalized = searchHint.toLowerCase();
  let score = 0;

  for (const term of allScoringTerms) {
    const pattern = termPatterns.get(term);
    if (!pattern) continue;

    if (parsed.parts.includes(term)) {
      score += 10;
    } else if (parsed.parts.some((p) => p.includes(term))) {
      score += 5;
    }

    if (parsed.full.includes(term) && score === 0) {
      score += 3;
    }

    if (hintNormalized.length > 0 && pattern.test(hintNormalized)) {
      score += 4;
    }

    if (pattern.test(descNormalized)) {
      score += 2;
    }
  }

  return score;
};

/**
 * Keyword search across the domain tool registry. Supports `+term`
 * required prefixes. Returns the top `maxResults` tool names sorted
 * by descending score.
 */
const searchToolsWithKeywords = (
  query: string,
  domainTools: SearchableToolRegistry,
  maxResults: number,
): string[] => {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const requiredTerms: string[] = [];
  const optionalTerms: string[] = [];
  for (const term of queryTerms) {
    if (term.startsWith("+") && term.length > 1) {
      requiredTerms.push(term.slice(1));
    } else {
      optionalTerms.push(term);
    }
  }

  const allScoringTerms =
    requiredTerms.length > 0
      ? [...requiredTerms, ...optionalTerms]
      : queryTerms;
  if (allScoringTerms.length === 0) return [];

  const termPatterns = compileTermPatterns(allScoringTerms);

  const candidates: [string, SearchableTool][] = [];
  for (const entry of Object.entries(domainTools)) {
    const [name, candidate] = entry;
    if (requiredTerms.length === 0) {
      candidates.push(entry);
      continue;
    }
    const parsed = parseToolName(name);
    const description = (
      typeof candidate.description === "string" ? candidate.description : ""
    ).toLowerCase();
    const hint = candidate.searchHint.toLowerCase();
    const matchesAllRequired = requiredTerms.every((term) => {
      const pattern = termPatterns.get(term);
      if (!pattern) return false;
      return (
        parsed.parts.includes(term) ||
        parsed.parts.some((p) => p.includes(term)) ||
        pattern.test(description) ||
        (hint.length > 0 && pattern.test(hint))
      );
    });
    if (matchesAllRequired) {
      candidates.push(entry);
    }
  }

  const scored: ScoredTool[] = candidates.map(([name, entry]) => ({
    name,
    score: scoreTool(
      name,
      entry.searchHint,
      typeof entry.description === "string" ? entry.description : "",
      allScoringTerms,
      termPatterns,
    ),
  }));

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((s) => s.name);
};

export const createSearchToolsTool = (domainTools: SearchableToolRegistry) =>
  tool({
    description: [
      "Fetches and activates domain tools listed under <domain_tools> in the system prompt. Until activated via this gateway, only a tool's name is known — there is no parameter schema, so it cannot be invoked. You MUST call this before trying to use any tool that is not in your core tool set.",
      "",
      "Query forms:",
      '- "select:listDocuments" — fetch this exact tool by name (preferred when you already know the name).',
      '- "select:listDocuments,getDocumentContent" — comma-separated multi-select.',
      '- "listDocuments" — bare tool name also works (fast-path exact-match), but `select:listDocuments` is more explicit and reliable.',
      '- "documents folder" — keyword search; returns up to max_results best matches and activates them all. Keywords are split on spaces and matched against tool name parts.',
      '- "+entity vendor" — require "entity" in the match, rank the rest.',
      "",
      "Activated tools become available in the next step — call them directly by name afterwards. Activation is idempotent: re-selecting an already-active tool is a harmless no-op.",
    ].join("\n"),
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'Query to find deferred tools. Use "select:<tool_name>" for direct selection (comma-separated for multi), or keywords to search.',
        ),
      max_results: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe("Maximum number of results to return (default: 5)"),
    }),
    execute: async ({ query, max_results }, options) => {
      const ctx = getRuntimeContext(options);
      const manager = ctx.dynamicToolManager;

      const totalDeferred = Object.keys(domainTools).length;
      const maxResults = max_results ?? DEFAULT_MAX_RESULTS;

      // A withheld tool must not be resurfaced or activated (the model would
      // see it as callable but the step-gate strips it — wasted turn). Two
      // sources: the workflow autonomy write-gate (`read_only` /
      // `approval_required`) AND the team's `blocked` tool policy (chat OR
      // workflow). Union both.
      const gated = new Set<string>(policyHiddenToolNames(ctx));
      if (ctx.workflowAutonomy) {
        for (const n of workflowMainHiddenToolNames(ctx.workflowAutonomy))
          gated.add(n);
      }
      const isGated = (name: string): boolean => gated.has(name);

      // Direct select path: `select:A,B,C`.
      const selectMatch = query.match(/^select:(.+)$/i);
      if (selectMatch) {
        const body = selectMatch[1] ?? "";
        const requested = body
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        const found: string[] = [];
        const notFound: string[] = [];
        const gatedNames: string[] = [];
        for (const name of requested) {
          if (isGated(name)) {
            gatedNames.push(name);
          } else if (name in domainTools) {
            if (!found.includes(name)) found.push(name);
          } else {
            notFound.push(name);
          }
        }

        if (found.length > 0) manager.activate(found);

        return {
          matches: found,
          query,
          total_deferred_tools: totalDeferred,
          ...(notFound.length > 0 ? { notFound } : {}),
          ...(gatedNames.length > 0 ? { gated: gatedNames } : {}),
        };
      }

      // Exact-match fast path — handles models that pass a bare tool name
      // instead of "select:<name>". Mirrors Claude Code's fast path in
      // ToolSearchTool.ts:199-204 (comment: "Handles models using a bare
      // tool name instead of select: prefix"). Without this, a glued
      // camelCase query like "listDocuments" is tokenized as one opaque
      // term that fails to match any parsed tool name part.
      const trimmed = query.trim();
      if (trimmed in domainTools) {
        if (isGated(trimmed)) {
          return {
            matches: [],
            query,
            total_deferred_tools: totalDeferred,
            gated: [trimmed],
          };
        }
        manager.activate([trimmed]);
        return {
          matches: [trimmed],
          query,
          total_deferred_tools: totalDeferred,
        };
      }

      // Keyword search path.
      const matches = searchToolsWithKeywords(
        query,
        domainTools,
        maxResults,
      ).filter((name) => !isGated(name));
      if (matches.length > 0) manager.activate(matches);
      return {
        matches,
        query,
        total_deferred_tools: totalDeferred,
      };
    },
  });
