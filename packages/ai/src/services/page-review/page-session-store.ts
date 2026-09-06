import { redis } from "@fretik/shared/lib/redis";
import { eachPageFile } from "@fretik/shared/schemas/pages";
import { parseIntEnv } from "../../agents/shared/env";
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
 * five is more than a build had ever needed.
 *
 * Six since the loop gained an elevation round (2026-09-04). The critique is
 * no longer a single pass: it re-scores after every change, and a page that
 * arrives correct but ordinary now spends a round making it better rather than
 * shipping at 6.1 with the improvement written down for somebody else. That
 * round has to come from somewhere, and the honest place is the budget rather
 * than out of the fixes.
 *
 * Three since 2026-09-06, from the curve rather than from an argument. Fifteen
 * scored trajectories, every round a page ever recorded: the score gains +0.60
 * in median across the whole six, the best round is the THIRD in median, and
 * the last round was the best in only 5 of 16. What rounds four onwards add
 * over the best of the first three is **+0.30** — six trajectories better,
 * three unchanged, three WORSE — against a critic whose spread on identical
 * bytes is 0.5 to 1.0. Half the rounds were buying a number inside their own
 * measurement error, and they are the expensive half: a late round replays a
 * history three times the size of an early one.
 *
 * `PAGE_MAX_REVIEWS` overrides it, because this is a quality-for-price trade
 * and the price moved: the number that justified six was taken when a page
 * cost $0.74, and it costs twice that now.
 */
export const MAX_PAGE_REVIEWS = parseIntEnv("PAGE_MAX_REVIEWS", {
  fallback: 3,
  min: 1,
  max: 12,
});

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
 * How many times in a row the critic could not be reached for this page.
 *
 * A failed critique deliberately consumes no review round — an upstream rate
 * limit is not the page's fault, and eating a round for it was a measured bug
 * (2026-08-23). What that leaves, though, is a call with no cost to the caller:
 * the review answers "the critic was unavailable, review again if you have
 * budget", the agent does, the budget never moves, and the loop is bounded only
 * by the agent's patience. Seen 2026-09-04 during an upstream rate limit on the
 * critic's model: two builds retrying the critic several times each, every
 * round also driving a browser and six screenshots.
 *
 * (The counts and dollars this used to quote came from a trace whose
 * observations were multiplied ~19x by a telemetry fan-out —
 * `lib/langfuse-registration.ts`. The unbounded shape was real; the size of it
 * was not, and the bound below is cheap either way.)
 *
 * So the round stays free and the ATTEMPT is counted. Reset on any critique that
 * comes back, so an incident costs a page two wasted rounds and never a loop.
 */
export const bumpCritiqueFailures = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<number> => {
  const key = `${reviewKey(conversationId, pageId)}:critic-down`;
  const count = await redis.incr(key);
  await redis.expire(key, TTL_SECONDS);
  return count;
};

export const clearCritiqueFailures = async (
  conversationId: string | undefined,
  pageId: string,
): Promise<void> => {
  await redis.del(`${reviewKey(conversationId, pageId)}:critic-down`);
};

/** Two attempts against a provider that is failing is diagnosis; more is a loop. */
export const MAX_CRITIQUE_FAILURES = 2;

/**
 * How many times in a row this page rendered without mounting.
 *
 * The same shape as the critic counter above, and for the same reason. A page
 * that never mounted was not judged, so the attempt rightly consumes no review
 * round — but that leaves another call with no cost to the caller, and the
 * caller repeats what is free. Each of those repeats drives a full browser
 * render, and the round budget that would eventually stop it never moves.
 *
 * So the round stays free and the ATTEMPT is counted. Cleared by any render
 * that mounts, so a page that crashes, gets fixed and crashes differently is
 * still allowed its second and third look.
 */
export const bumpUnmountedLooks = async (
  /**
   * The TURN, like the review budget beside it and unlike the critic counter
   * above — a crash-fix loop belongs to one build, while an upstream outage
   * belongs to whatever conversation is running into it.
   */
  scope: string | undefined,
  pageId: string,
): Promise<number> => {
  const key = `${reviewKey(scope, pageId)}:unmounted`;
  const count = await redis.incr(key);
  await redis.expire(key, TTL_SECONDS);
  return count;
};

export const clearUnmountedLooks = async (
  scope: string | undefined,
  pageId: string,
): Promise<void> => {
  await redis.del(`${reviewKey(scope, pageId)}:unmounted`);
};

/**
 * How many page BUILDS this turn has dispatched.
 *
 * Every `buildPage` of one turn shares a working copy, a pageId and a review
 * budget — the builder's scope is the turn's trace plus a constant `.page`
 * suffix — so a second dispatch does not build a second page, it resumes the
 * first one with a fresh 80-step budget and no memory of what the first found.
 * Nothing bounded that: the parent's own prose invites another call on several
 * of `formatBuildResult`'s branches, and `managePage review` answers "that
 * work is buildPage's".
 *
 * Not observed running away in production — the trace that looked like 22
 * builds was one build multiplied by a telemetry fan-out — but the shape is
 * there in the code, and a build is the most expensive thing a turn can do.
 */
export const bumpTurnBuilds = async (
  scope: string | undefined,
): Promise<number> => {
  // Keyed on the turn ALONE. Not on the page: the pageId does not exist until
  // the first build has produced one, so folding it in would give the first
  // dispatch and the second different keys and count both as the first.
  const key = `pages:build:${scope ?? "no-turn"}`;
  const count = await redis.incr(key);
  await redis.expire(key, TTL_SECONDS);
  return count;
};

/**
 * Two, not one.
 *
 * `formatBuildResult` itself says "Call buildPage once more with the same
 * task" when a run saved nothing at all, and that retry is the right move: a
 * build that produced no page has nothing to resume and nothing to review. So
 * the second dispatch is allowed when there is no page yet, and refused when
 * there is one — at that point the cheap remedies (`managePage review`,
 * `update`) are the ones that apply.
 */
export const MAX_TURN_BUILDS = 2;

/**
 * Three, matching `MAX_EDIT_FAILURES`.
 *
 * A crash is one round to read and fix. A fix that introduces a second crash
 * is two. The third miss in a row is the same signal the edit path already
 * stops on — at that point the loop is not converging and the honest move is
 * to hand the page over saying it was never verified.
 */
export const MAX_UNMOUNTED_LOOKS = 3;

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
