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
 * The same count, without moving it. Only the evals read this: measuring
 * whether the review loop actually ran is not something a turn can observe
 * about itself, and an observer that incremented the counter would change the
 * budget it came to measure.
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
