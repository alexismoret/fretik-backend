import jsonata from "jsonata";

/**
 * The `$` binding's evaluator — a thin, hardened wrapper around JSONata.
 *
 * Runs in BOTH runtimes: Bun (the tool's dry-run, server-side filter
 * resolution) and the browser (every binding the renderer resolves). It lives
 * in this package for one reason: it used to be written twice, once per side,
 * with a comment on each copy asking the reader to keep them in lockstep. A
 * divergence there means a page that validates on the server and renders wrong
 * in the browser — the exact failure this package exists to make impossible.
 *
 * Kept OUT of `core/` and `catalogs/` on purpose: those must stay importable
 * from a bare script with nothing but zod, and this one pulls jsonata.
 *
 * Why JSONata rather than a home-grown mini-language: it is maintained, safe by
 * construction (pure data querying — no host access, no code execution, no
 * prototype reach), far more expressive than anything worth hand-rolling
 * (filters, projections, aggregations, joins, string/date builtins), and
 * deployed widely enough — Node-RED, AWS Step Functions — that models write it
 * fluently.
 *
 * Three guards make an agent-authored expression safe to run on a public page:
 * a wall-clock timeout, an evaluation-stack cap, and a sequence-length cap. All
 * three are JSONata's own native options (checked by its `guardrails` hook
 * around every sub-expression) rather than the older userland timeboxing
 * recipe, which no longer fires in v2.
 */

/** What an expression is evaluated against. */
export interface PageEvalScope {
  /** Page state — controls write it, expressions read `state.<key>`. */
  state: Record<string, unknown>;
  /** Dataset rows, read as `data.<datasetId>`. */
  data: Record<string, unknown>;
  /** The current row inside a `repeat`. Whatever the data holds. */
  item?: unknown;
  /** The current row's index inside a `repeat`. */
  index?: number;
}

export interface PageEvalOptions {
  /** Wall-clock ceiling for one evaluation. */
  timeoutMs?: number;
  /** Evaluation-stack ceiling (guards runaway recursion). */
  maxDepth?: number;
  /** Ceiling on the length of any intermediate sequence. */
  maxSequence?: number;
}

export const PAGE_EVAL_DEFAULTS = {
  timeoutMs: 1000,
  maxDepth: 300,
  maxSequence: 100_000,
} as const;

export type PageEvalResult =
  { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Compiled-expression cache. The renderer re-evaluates the same bindings on
 * every state change; recompiling per tick is pure waste. Bounded so a
 * pathological page cannot grow it without limit.
 */
const COMPILE_CACHE_MAX = 500;
const compileCache = new Map<string, ReturnType<typeof jsonata>>();

const errorMessage = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    const message: unknown = Reflect.get(cause, "message");
    if (typeof message === "string") return message;
  }
  return String(cause);
};

/**
 * Compile (and cache) an expression with the runaway guards armed. The timeout
 * clock restarts on each `evaluate`, so caching a compiled expression is safe.
 *
 * Returns null when the source does not parse — the dry-run reports that to the
 * agent as a warning rather than failing the whole page.
 */
export const compilePageExpression = (
  source: string,
  options: PageEvalOptions = {},
): ReturnType<typeof jsonata> | null => {
  const timeout = options.timeoutMs ?? PAGE_EVAL_DEFAULTS.timeoutMs;
  const stack = options.maxDepth ?? PAGE_EVAL_DEFAULTS.maxDepth;
  const sequence = options.maxSequence ?? PAGE_EVAL_DEFAULTS.maxSequence;
  const cacheKey = `${timeout.toString()}:${stack.toString()}:${sequence.toString()}:${source}`;

  const cached = compileCache.get(cacheKey);
  if (cached) return cached;
  try {
    const compiled = jsonata(source, { timeout, stack, sequence });
    if (compileCache.size >= COMPILE_CACHE_MAX) compileCache.clear();
    compileCache.set(cacheKey, compiled);
    return compiled;
  } catch {
    return null;
  }
};

/** Syntax-only check, used by the sanitizer to catch typos before saving. */
export const pageExpressionSyntaxError = (source: string): string | null => {
  try {
    jsonata(source);
    return null;
  } catch (cause) {
    return errorMessage(cause);
  }
};

/**
 * Evaluate one expression. Never throws: a bad expression degrades to an error
 * result so one broken binding cannot take a page down.
 */
export const evaluatePageExpression = async (
  source: string,
  scope: PageEvalScope,
  options: PageEvalOptions = {},
): Promise<PageEvalResult> => {
  const compiled = compilePageExpression(source, options);
  if (!compiled) {
    return { ok: false, error: `could not parse expression: ${source}` };
  }

  try {
    const value: unknown = await compiled.evaluate({
      state: scope.state,
      data: scope.data,
      item: scope.item ?? null,
      index: scope.index ?? 0,
    });
    return { ok: true, value };
  } catch (cause) {
    return { ok: false, error: errorMessage(cause) };
  }
};

/** Truthiness used by an element's `visible`. */
export const isTruthyPageValue = (value: unknown): boolean => {
  if (value === undefined || value === null || value === false) return false;
  if (value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
};
