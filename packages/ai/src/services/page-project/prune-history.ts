import type { ModelMessage } from "ai";

/**
 * Drop the bodies of file writes a later write has already replaced — when the
 * model this build runs on makes that worth what it costs.
 *
 * A build's history grows by the size of every file it writes, and every step
 * pays for all of it again. The first multi-file build measured what that
 * costs: 39 model calls averaging 83 000 input tokens, 3.25M in total against
 * 44K of output — output down 45% on the single-file design it replaced, and
 * the bill up 19% anyway, because the cost had simply moved sides.
 *
 * The observation that fixes it: once `components/KpiStrip.vue` has been
 * written twice, the FIRST body is not context, it is history. Nothing the
 * model does next depends on the version it already replaced, and the current
 * one is a `pageRead` away. So the superseded body becomes one line saying so.
 *
 * That measurement was in TOKENS, and on a model that discounts a cached read
 * tokens are not the price. Measured 2026-09-04 on Gemini 3.7 Flash: input
 * billed at an effective $0.249 per million against a $0.75 list — so about
 * three quarters of it was served from cache at $0.075/M, a tenth of the full
 * rate. Against that, pruning inverts:
 *
 *   - the superseded body it removes was billed at the CACHE rate. Dropping
 *     ~1 200 tokens saves about $0.00009 on each later step;
 *   - removing it REWRITES a message the provider has already cached, so
 *     everything after it reverts to the full rate on the next call. Thirty
 *     thousand tokens at $0.675 of difference is about $0.02, once;
 *   - and it fires on every rewrite of a path already written, which is most
 *     of them.
 *
 * The RATE above is what this argument rests on, and it is the part that
 * survived: the call counts and dollar totals this docblock used to quote
 * were inflated by a telemetry fan-out (`lib/langfuse-registration.ts`), which
 * multiplied numerator and denominator alike and left the ratio intact. The
 * per-page write count it also quoted was a separate artefact — see
 * `scripts/measure-page-writes.ts`, which now counts calls.
 *
 * Ten to one against — but only where the discount exists. So the decision is
 * read from what the model's own row publishes rather than fixed here: with a
 * cache read materially cheaper than a fresh one, pruning becomes a PRESSURE
 * VALVE that opens only when the history threatens the context window; without
 * one, every retained token is billed at full rate on every step and the
 * eager pruning above is still the right answer. A model that publishes no
 * cache price at all is not a model without a cache, it is a model nobody
 * measured — and there the cheaper mistake is to keep pruning.
 *
 * What is deliberately NOT pruned, at any size:
 *   - the last write of every path — that is the file, as the model believes it
 *     to be, and forgetting it would make the model re-read what it just wrote;
 *   - tool RESULTS, which are small and carry the lint findings a fix depends
 *     on;
 *   - anything that is not a page write. This function knows one tool.
 *
 * `prepareStep` applies it: the override carries forward, so a body is pruned
 * once and stays pruned.
 */

const WRITE_TOOL = "pageWrite";

/**
 * What the build runs on — the two facts that decide whether a body is worth
 * more in the context or out of it. Both come from the resolved model's
 * profile, so a team that switches model switches this with it.
 */
export interface PrunePricing {
  /** The model's context window, in tokens. */
  contextTokens: number;
  /** List price of a fresh input token, per million. */
  inputPerMTok: number;
  /** Price of a cached read, per million. Absent when nothing published one. */
  cacheReadPerMTok?: number;
}

/**
 * How much cheaper a cached read has to be before carrying history beats
 * shortening it. Half is well clear of both cases seen: the discount is
 * typically 10x where it exists, and absent where it does not.
 */
const CACHE_PAYS_BELOW = 0.5;

/**
 * Where the valve opens, as a share of the context.
 *
 * Not a property of any model — it is the point where the run is heading for a
 * wall the cache cannot save it from, and it is already relative to whatever
 * window the model has. Not 90%: the prune has to happen while there is still
 * room for the steps that come after it.
 */
const PRUNE_AT_CONTEXT_FRACTION = 0.6;

/**
 * Deliberately conservative — a page's history is code, which tokenizes nearer
 * 3.7 chars per token, so this UNDER-counts and the valve opens slightly late.
 * Late is the safe direction: opening early is the behaviour being undone.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Whether this history is big enough that shortening it beats keeping it
 * cached. `true` on any model whose cached reads are not materially cheaper —
 * there, nothing is being traded away.
 */
const worthPruning = (
  messages: readonly ModelMessage[],
  pricing: PrunePricing,
): boolean => {
  const discounted =
    pricing.cacheReadPerMTok !== undefined &&
    pricing.cacheReadPerMTok <= pricing.inputPerMTok * CACHE_PAYS_BELOW;
  if (!discounted) return true;
  const estimatedTokens = JSON.stringify(messages).length / CHARS_PER_TOKEN;
  return estimatedTokens >= pricing.contextTokens * PRUNE_AT_CONTEXT_FRACTION;
};

const SUPERSEDED =
  "[superseded: you wrote this file again later. The body was dropped from this message to keep the context small — pageRead it if you need what it says now.]";

/** A tool-call part, structurally — the SDK's union is wider than we need. */
interface WriteCall {
  type: string;
  toolName?: unknown;
  input?: unknown;
}

const isWriteCall = (part: unknown): part is WriteCall =>
  typeof part === "object" &&
  part !== null &&
  Reflect.get(part, "type") === "tool-call" &&
  Reflect.get(part, "toolName") === WRITE_TOOL;

/** The paths one `pageWrite` call wrote, in order. */
const pathsOf = (input: unknown): string[] => {
  if (typeof input !== "object" || input === null) return [];
  const files = Reflect.get(input, "files");
  if (!Array.isArray(files)) return [];
  const paths: string[] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) continue;
    const path = Reflect.get(file, "path");
    if (typeof path === "string") paths.push(path);
  }
  return paths;
};

/** The same input with the named files' bodies replaced by one line. */
const withoutBodies = (input: unknown, drop: Set<string>): unknown => {
  if (typeof input !== "object" || input === null) return input;
  const files = Reflect.get(input, "files");
  if (!Array.isArray(files)) return input;
  const next = files.map((file) => {
    if (typeof file !== "object" || file === null) return file;
    const path = Reflect.get(file, "path");
    if (typeof path !== "string" || !drop.has(path)) return file;
    return { ...file, content: SUPERSEDED };
  });
  return { ...input, files: next };
};

/**
 * Every message, with superseded write bodies collapsed.
 *
 * Returns `null` when nothing should change — nothing was superseded, or the
 * model's cache makes carrying it cheaper than rewriting it — so a build that
 * writes each file once pays nothing for this, including the identity check the
 * SDK makes on the override.
 */
export const prunePageWriteHistory = (
  messages: readonly ModelMessage[],
  pricing: PrunePricing,
): ModelMessage[] | null => {
  if (!worthPruning(messages, pricing)) return null;

  // Where each path was written LAST. Walking forward and overwriting leaves
  // exactly the surviving write per path.
  const lastWrite = new Map<string, number>();
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (!isWriteCall(part)) continue;
      for (const path of pathsOf(part.input)) lastWrite.set(path, index);
    }
  });

  let changed = false;
  const pruned: ModelMessage[] = [];
  for (const [index, message] of messages.entries()) {
    // Tool calls live on assistant messages and nowhere else. Narrowing on the
    // role keeps every other message its own type rather than widening the
    // whole array to the union's lowest common shape.
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      pruned.push(message);
      continue;
    }
    let touched = false;
    const content = message.content.map((part) => {
      if (!isWriteCall(part)) return part;
      const drop = new Set(
        pathsOf(part.input).filter((path) => lastWrite.get(path) !== index),
      );
      if (drop.size === 0) return part;
      touched = true;
      return { ...part, input: withoutBodies(part.input, drop) };
    });
    if (!touched) {
      pruned.push(message);
      continue;
    }
    changed = true;
    pruned.push({ ...message, content });
  }

  return changed ? pruned : null;
};
