import { redis } from "@fretik/shared/lib/redis";
import { eachPageFile } from "@fretik/shared/schemas/pages";
import type { PageElevation, PageFinding } from "./evaluate";

/**
 * What this conversation has already done with pages — the two facts a single
 * tool call cannot know about itself.
 *
 * Both live in Redis rather than on the page row because they are properties of
 * the BUILD, not of the page: a page revisited next week starts with a fresh
 * review budget and a fresh obligation to re-read the component APIs, which is
 * exactly right — the conversation that knew them is gone.
 */

/**
 * How many times one page may be RENDERED for review in a run.
 *
 * It was three SCORED rounds, and the measurement that ended that: over two
 * production builds the three rounds scored 6.6 → 6.8 → 7.0 and 6.3 → 6.6 →
 * 6.1, every step inside the critic's own run-to-run spread (the same bytes
 * scored 6.8 and 7.8 two minutes apart, 2026-08-23). Three paid critiques
 * bought noise. The loop is now gate-first with ONE critique, so what is
 * bounded is renders — the gate is cheap and worth repeating after a fix, and
 * five is more than a build has ever needed.
 */
export const MAX_PAGE_REVIEWS = 5;

/** Long enough to cover a build session, short enough to forget it after. */
const TTL_SECONDS = 24 * 60 * 60;

const reviewKey = (
  conversationId: string | undefined,
  pageId: string,
): string =>
  conversationId
    ? `pages:review:${conversationId}:${pageId}`
    : `pages:review:page:${pageId}`;

/**
 * How many times this page has been rendered for review, so the builder can be
 * told to stop. Nothing enforces the budget for the model, so the count travels
 * with the review result and the directive changes at the cap.
 */
export const bumpPageReviewIteration = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<number> => {
  const key = reviewKey(conversationId, pageId);
  const count = await redis.incr(key);
  await redis.expire(key, TTL_SECONDS);
  return count;
};

/**
 * The same count, without moving it — how the budget is ENFORCED. `review`
 * reads it before rendering anything, so a spent budget costs no browser, no
 * screenshots and no critic call; the bump happens only once a round has
 * actually been scored. An observer that incremented would change the budget
 * it came to measure, which is also why the evals read through here.
 */
export const readPageReviewIterations = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<number> => {
  const raw = await redis.get(reviewKey(conversationId, pageId));
  const count = raw === null ? 0 : Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : 0;
};

/**
 * The ONE critique this run has paid for, if any.
 *
 * The critic looks once, after the mechanical gate is clean, and its findings
 * are applied once. What follows is a gate-only pass: a second opinion on a
 * page whose first opinion has been applied measures the critic, not the page.
 */
const critiqueKey = (
  conversationId: string | undefined,
  pageId: string,
): string =>
  conversationId
    ? `pages:critique:${conversationId}:${pageId}`
    : `pages:critique:page:${pageId}`;

export interface PageCritiqueRecord {
  /** The bytes it judged. */
  sourceHash: string;
  score: number;
  findings: PageFinding[];
  elevations: PageElevation[];
}

export const recordPageCritique = async (
  conversationId: string | undefined,
  pageId: string,
  critique: PageCritiqueRecord,
): Promise<void> => {
  await redis.setex(
    critiqueKey(conversationId, pageId),
    TTL_SECONDS,
    JSON.stringify(critique),
  );
};

export const readPageCritique = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<PageCritiqueRecord | null> => {
  const raw = await redis.get(critiqueKey(conversationId, pageId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "score" in parsed) {
      return parsed as PageCritiqueRecord;
    }
  } catch {
    // A malformed record means the critic looks again, which is safe.
  }
  return null;
};

/**
 * The last SCORED verdict of THIS scope, tied to the exact bytes it judged.
 *
 * Re-scoring an unchanged page measures the critic's variance, not the page:
 * the same 57k-char source scored 6.8 and 7.8 two minutes apart
 * (2026-08-23, `pages-final-v2`), and the parent re-reviewing what the builder
 * had just reviewed was one of the two ways a 3-round budget became 5 rounds.
 *
 * Scoped like the budget, and for the same reason: within one turn the builder
 * and the parent look at the same page and must not each pay for it, while a
 * LATER turn — "the page looks broken, check it" — has to be able to look
 * again. A verdict that outlived its turn would answer that with yesterday's
 * "ship".
 */
const verdictKey = (
  conversationId: string | undefined,
  pageId: string,
): string =>
  conversationId
    ? `pages:review-verdict:${conversationId}:${pageId}`
    : `pages:review-verdict:page:${pageId}`;

export interface PageReviewVerdict {
  sourceHash: string;
  shipped: boolean;
  round: number;
  result: Record<string, unknown>;
}

/**
 * `Bun.hash` is out for anything persisted (its seed is per-process); the
 * verdict outlives the process in Redis, so this is CryptoHasher.
 */
export const hashPageSource = (source: string): string =>
  new Bun.CryptoHasher("sha256").update(source).digest("hex");

/**
 * The same, over a whole project — what a verdict is actually pinned to now
 * that a page is several files. Hashing the entry alone would let a component
 * change under a "ship" verdict without anyone re-reviewing it.
 */
export const hashPageCode = (code: {
  source: string;
  files?: Record<string, string> | undefined;
}): string => {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const [path, content] of eachPageFile(code)) {
    hasher.update(`${path}\0${content}\0`);
  }
  return hasher.digest("hex");
};

export const recordPageReviewVerdict = async (
  conversationId: string | undefined,
  pageId: string,
  verdict: PageReviewVerdict,
): Promise<void> => {
  await redis.setex(
    verdictKey(conversationId, pageId),
    TTL_SECONDS,
    JSON.stringify(verdict),
  );
};

export const readPageReviewVerdict = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<PageReviewVerdict | null> => {
  const raw = await redis.get(verdictKey(conversationId, pageId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sourceHash" in parsed &&
      "result" in parsed
    ) {
      return parsed as PageReviewVerdict;
    }
  } catch {
    // A malformed verdict is a cache miss, not a failed review.
  }
  return null;
};

/**
 * The source a refused write carried, kept so the fix costs an edit instead of
 * a re-emission.
 *
 * A compile failure used to discard the submitted SFC ("Nothing was saved …
 * resend it"), and the resend of a 60k-char page is ~16k output tokens paid
 * twice — measured as roughly half the builder's Gemini answer tokens on
 * 2026-08-23. Scoped to the turn and 15 minutes: long enough to fix the named
 * lines, short enough — and narrow enough — that a later, unrelated edit never
 * lands on a stale buffer.
 */
const draftKey = (
  conversationId: string | undefined,
  pageId: string,
): string =>
  conversationId
    ? `pages:draft:${conversationId}:${pageId}`
    : `pages:draft:page:${pageId}`;
const DRAFT_TTL_SECONDS = 15 * 60;

export const savePageDraft = async (
  conversationId: string | undefined,
  pageId: string,
  source: string,
): Promise<void> => {
  await redis.setex(
    draftKey(conversationId, pageId),
    DRAFT_TTL_SECONDS,
    source,
  );
};

export const readPageDraft = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<string | null> => redis.get(draftKey(conversationId, pageId));

export const clearPageDraft = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<void> => {
  await redis.del(draftKey(conversationId, pageId));
};

/**
 * Which component APIs have been READ in this conversation.
 *
 * Kept per conversation, not per page: the API of `UModal` is the same for
 * every page, and a builder that read it for one should not be nagged on the
 * next. Without a conversation there is nothing to remember against, so the
 * check simply does not run rather than warning about everything.
 */
const componentsKey = (conversationId: string): string =>
  `pages:components-read:${conversationId}`;

export const recordComponentsRead = async (
  conversationId: string | undefined,
  components: string[],
): Promise<void> => {
  if (!conversationId || components.length === 0) return;
  const key = componentsKey(conversationId);
  await redis.sadd(key, ...components);
  await redis.expire(key, TTL_SECONDS);
};

export const listComponentsRead = async (
  conversationId: string | undefined,
): Promise<Set<string>> =>
  conversationId
    ? new Set(await redis.smembers(componentsKey(conversationId)))
    : new Set();
