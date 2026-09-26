/**
 * The key OpenRouter pins a conversation's routing on.
 *
 * ## What it buys
 *
 * A provider's prompt cache is its own: a lane that changes host pays full rate
 * for a prefix it was getting cached. OpenRouter already solves this — it keeps
 * a sticky session per (account, model, conversation) — but without an explicit
 * key it derives one by hashing the first system message and the first
 * non-system message. Our system prompt carries a per-turn suffix, so that hash
 * changes with almost every turn and the pin never takes hold.
 *
 * Measured against the live API on 2026-09-22 (`z-ai/glm-5.3-flash`,
 * `sort: "throughput"`, tools present so Auto Exacto is active): seeded on
 * Together, six follow-up calls went to CoreWeave with `cached = 0` every time
 * without a `session_id`, and stayed on Together at 97 % cached with one. The
 * pin beats both the throughput sort and Auto Exacto, which is what lets the
 * sort keep choosing the fastest host for the FIRST call of a lane while the
 * pin stops us paying for the churn after it. `bun run probe:cache` is that
 * experiment, rerunnable.
 *
 * Two behaviours worth knowing, both wanted, neither ours to implement: the
 * session expires after 10 minutes of inactivity (by which point the upstream
 * caches, 3-5 minutes on most hosts, are cold anyway), and when the pinned host
 * errors OpenRouter re-routes and then re-pins to whichever host answered.
 *
 * ## What must NOT be used as a key
 *
 * `ctx.traceId` is the per-turn stream id for a top-level agent. Keying on it
 * would open a new lane every turn — the exact granularity this exists to fix.
 * It is the right key for a DELEGATE, whose whole life is one turn; see below.
 *
 * @see https://openrouter.ai/docs/guides/best-practices/prompt-caching
 */

/** OpenRouter refuses a longer key. */
export const SESSION_ID_MAX_CHARS = 256;

/**
 * Which span of work shares one pinned host.
 *
 * `conversation` — a chat conversation or a workflow run: many turns over one
 * growing prefix.
 *
 * `delegate` — one `dispatchAgent` or `buildPage` call, including its retries
 * and boundary resumes.
 *
 * A delegate gets its OWN lane rather than the parent's, and the reason is a
 * regression we would otherwise have built deliberately. `dispatchAgent`
 * forwards the parent's `conversationId`, and its sub-agent runs on the
 * parent's own model (`agents/chatbot/delegate.ts`). Since stickiness is keyed per
 * model, a shared key puts parent and delegate on one pin: the delegate hits a
 * provider error, OpenRouter re-routes and re-pins the session, and the
 * parent's next step follows the new host while its 100K prefix is warm on the
 * old one. Two lesser reasons point the same way — parallel delegates in one
 * step would serialise onto a single pin, and a 25-minute page build would hold
 * the conversation's pin for its whole duration.
 *
 * The counter-argument, that sharing keeps the parent's 10-minute timer alive
 * through a long delegate, does not survive the numbers: after a build that
 * long the parent's upstream cache has expired regardless, so sharing buys the
 * routing and not the cache.
 */
export type SessionScope = "conversation" | "delegate";

/** The ids a scope can be derived from — the subset of the runtime context. */
export interface SessionIdentity {
  conversationId?: string | undefined;
  workflowRunId?: string | undefined;
  traceId?: string | undefined;
}

/**
 * The sticky key for one call, or `undefined` when nothing stable is in scope.
 *
 * Sending nothing is a real answer, not a fallback to something worse. With no
 * key OpenRouter uses its own hash of the opening messages, which for a
 * delegate is a GOOD key: its first non-system message is the whole briefing
 * and never changes. Reaching for the parent's conversation id instead would
 * recreate the shared-pin problem the scope exists to avoid.
 *
 * A workflow run wins over the conversation it belongs to: the run is the span
 * with a continuous prefix, and the workflow prompt is byte-stable per run by
 * construction (`prompt-renderer.ts`), while the conversation around it may
 * outlive several runs.
 */
export const providerSessionId = (
  scope: SessionScope,
  identity: SessionIdentity,
): string | undefined => {
  const raw =
    scope === "delegate"
      ? identity.traceId
      : (identity.workflowRunId ?? identity.conversationId);
  if (raw === undefined || raw.length === 0) return undefined;
  return raw.slice(0, SESSION_ID_MAX_CHARS);
};
