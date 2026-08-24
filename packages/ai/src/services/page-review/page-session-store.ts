import { redis } from "@fretik/shared/lib/redis";

/**
 * What this conversation has already done with pages — the two facts a single
 * tool call cannot know about itself.
 *
 * Both live in Redis rather than on the page row because they are properties of
 * the BUILD, not of the page: a page revisited next week starts with a fresh
 * review budget and a fresh obligation to re-read the component APIs, which is
 * exactly right — the conversation that knew them is gone.
 */

export const MAX_PAGE_REVIEW_ITERATIONS = 3;

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
 * How many times this page has been reviewed, so the builder can be told to
 * stop. Refinement loops driven by a visual critic plateau fast — the published
 * ablations put the useful range at two to three passes, after which edits
 * trade one flaw for another. Nothing enforces the budget for the model, so the
 * count travels with the review result and the directive changes at the cap.
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
 * What each review round scored, and which stored version holds it.
 *
 * The loop needs this because refinement is NOT monotonic: a published ablation
 * (ReLook) finds revisions that regress, and best-of-cycles beats last-cycle by
 * several points because the best page often appears mid-loop rather than at
 * the end. Keeping only the final state throws that away by construction.
 *
 * Scores live here rather than on the page row for the same reason as the
 * counters above: they belong to one build session, not to the page.
 */
const roundsKey = (
  conversationId: string | undefined,
  pageId: string,
): string =>
  conversationId
    ? `pages:rounds:${conversationId}:${pageId}`
    : `pages:rounds:page:${pageId}`;

export interface PageReviewRound {
  round: number;
  versionNumber: number;
  score: number;
  gatePass: boolean;
}

export const recordPageReviewRound = async (
  conversationId: string | undefined,
  pageId: string,
  entry: PageReviewRound,
): Promise<void> => {
  const key = roundsKey(conversationId, pageId);
  await redis.hset(key, {
    [String(entry.round)]: JSON.stringify(entry),
  });
  await redis.expire(key, TTL_SECONDS);
};

/**
 * How much better an earlier round must have scored before the page is put
 * back into it. The critic's own run-to-run spread is a couple of tenths, so a
 * tie-break would swap the page over noise — which is its own kind of damage.
 */
export const BEST_ROUND_MARGIN = 0.3;

/**
 * The earlier round worth returning to, or null to keep what is on screen.
 *
 * Only rounds that PASSED their gate qualify: a higher design score on a page
 * with an empty overlay or a dead control is a prettier broken page, and the
 * gate is measured while the score is judged.
 */
export const bestEarlierRound = (
  rounds: PageReviewRound[],
  current: { round: number; score: number },
): PageReviewRound | null =>
  rounds
    .filter(
      (round) =>
        round.gatePass &&
        round.round !== current.round &&
        round.score > current.score + BEST_ROUND_MARGIN,
    )
    .sort((a, b) => b.score - a.score)[0] ?? null;

export const listPageReviewRounds = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<PageReviewRound[]> => {
  const raw = await redis.hgetall(roundsKey(conversationId, pageId));
  const rounds: PageReviewRound[] = [];
  for (const value of Object.values(raw)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "round" in parsed &&
        "versionNumber" in parsed &&
        "score" in parsed
      ) {
        rounds.push(parsed as PageReviewRound);
      }
    } catch {
      // A malformed entry is one lost round, not a failed review.
    }
  }
  return rounds.sort((a, b) => a.round - b.round);
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
