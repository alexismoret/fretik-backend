import { redis } from "@fretik/shared/lib/redis";
import {
  advanceWorkerCursor,
  ensureWorkerCursor,
  readEventsAfter,
} from "@fretik/shared/services/domain-events/consume";
import {
  getMemoryDistillQueue,
  getMemoryResolveQueue,
  getRecordCardQueue,
} from "../queues/queues";

/**
 * The journal→memory bridge. Every sweep advances the `memory-resolver`
 * cursor over `domain_events` and fans each event out as an idempotent
 * `memory-resolve` job (`jobId = resolve-{eventId}` — a stale concurrent
 * sweep double-enqueues into a BullMQ no-op). `chat.turn` events also
 * debounce-enqueue their conversation's distillation: the delayed job is
 * replaced on every new turn, so a conversation distills once it has been
 * quiet for the debounce window (one LLM call per conversation, on its
 * complete content), not once per turn.
 *
 * Polling over enqueue-at-emit is deliberate: the journal IS the
 * transactional outbox — the ~10 emit sites need zero changes and a
 * worker/Redis outage never loses anything (the cursor just stops
 * advancing and resumes where it left off).
 *
 * WHY the watermark: an event's uuid v7 id is stamped at INSERT time but
 * the row only becomes visible at COMMIT. Without a lag, a sweep can see a
 * fast-committing later event, advance the cursor past a slower
 * transaction's still-invisible earlier id, and permanently skip that event
 * once it commits. Reading only rows older than the watermark
 * (`recorded_at <= now() - lag`) makes the sweep correct for every
 * transaction shorter than the lag — mutation transactions here run in
 * milliseconds, so 15s is a ~1000× margin. Residual risk (a tx held open
 * longer than the lag) is accepted for background memory and backstopped by
 * the nightly consolidation pass.
 */

const CURSOR_NAME = "memory-resolver";

const intFromEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

/** Consistency lag — must exceed the longest event-emitting transaction. */
const WATERMARK_MS = intFromEnv("MEMORY_SWEEP_WATERMARK_MS", 15_000);
/** Per-sweep read ceiling: a backlog drains progressively, never in one load. */
const SWEEP_BATCH = intFromEnv("MEMORY_SWEEP_BATCH", 500);
/** Quiet time before a conversation is considered "over" and distilled. */
const DISTILL_DEBOUNCE_MS = intFromEnv(
  "MEMORY_DISTILL_DEBOUNCE_MS",
  30 * 60 * 1000,
);
/**
 * Quiet time before a record's card re-embeds — coalesces edit bursts
 * (a user filling five fields in a row) into one vectorize roundtrip.
 */
const CARD_DEBOUNCE_MS = intFromEnv("MEMORY_CARD_DEBOUNCE_MS", 60_000);
/**
 * A cron workflow distills at most once per this window (per workflow). A
 * schedule firing many times a day would otherwise mint ~24 near-identical
 * episodes daily, skewing recall scoring toward the crons.
 */
const CRON_DISTILL_TTL_S = intFromEnv(
  "MEMORY_CRON_DISTILL_TTL_S",
  24 * 60 * 60,
);

/** Event types the resolver has nothing to do with — linked at source, or
 * (`workflow.`) carrying only ids the LLM mention-extraction would waste a
 * call on. */
const RESOLVE_SKIP_PREFIXES = [
  "record.",
  "link.",
  "link_type.",
  "episode.",
  "workflow.",
];

const needsResolve = (type: string): boolean =>
  !RESOLVE_SKIP_PREFIXES.some((p) => type.startsWith(p));

export const runJournalSweep = async (): Promise<{ swept: number }> => {
  const cursor = await ensureWorkerCursor(CURSOR_NAME);
  const events = await readEventsAfter({
    after: cursor,
    watermarkMs: WATERMARK_MS,
    limit: SWEEP_BATCH,
  });
  if (events.length === 0) return { swept: 0 };

  const toResolve = events.filter((e) => needsResolve(e.type));
  if (toResolve.length > 0) {
    await getMemoryResolveQueue().addBulk(
      toResolve.map((e) => ({
        name: "resolve",
        data: {
          eventId: e.id,
          organizationId: e.organizationId,
          teamId: e.teamId,
          type: e.type,
        },
        opts: {
          // BullMQ forbids ":" in custom job ids (Redis key separator).
          jobId: `resolve-${e.id}`,
          attempts: 3,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { count: 1_000 },
          removeOnFail: { count: 1_000 },
        },
      })),
    );
  }

  // Debounced distillation — one pending job per conversation, pushed back on
  // every new turn. Remove-then-add: an already-running job can't be removed
  // (caught + skipped — the add then no-ops on the live jobId); the nightly
  // consolidation safety net covers that edge. The `add` itself is NOT
  // caught: a real Redis failure must fail the sweep so the cursor stays put
  // and the batch replays — swallowing it would mark the event consumed with
  // its side-effect silently lost.
  const conversations = new Map<
    string,
    { organizationId: string; teamId: string }
  >();
  for (const e of events) {
    if (e.type === "chat.turn" && e.conversationId) {
      conversations.set(e.conversationId, {
        organizationId: e.organizationId,
        teamId: e.teamId,
      });
    }
  }
  const distillQueue = getMemoryDistillQueue();
  for (const [conversationId, scope] of conversations) {
    const jobId = `distill-${conversationId}`;
    await distillQueue.remove(jobId).catch(() => {});
    await distillQueue.add(
      "distill",
      { conversationId, ...scope },
      {
        jobId,
        delay: DISTILL_DEBOUNCE_MS,
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    );
  }

  // Workflow runs are headless — they emit no `chat.turn`, so there is no
  // debounce to ride. A SUCCEEDED run's conversation distills IMMEDIATELY when
  // its terminal event is swept (the run is over, its transcript complete).
  // Failed/canceled runs are skipped: they rarely hold anything worth
  // remembering, and skipping them saves the distill LLM call.
  //
  // Two gates keep the episode store clean (a workflow can run far more often
  // than a human chats):
  //   - test runs are builder scratch (synthetic payloads, throwaway) — never
  //     distilled;
  //   - cron runs distill at most once per `CRON_DISTILL_TTL_S` per workflow
  //     (Redis SET NX), so an hourly schedule doesn't mint ~24 near-identical
  //     episodes a day. The dropped runs' transcripts still live on the run
  //     page, and the daily consolidation pass covers the residual.
  for (const e of events) {
    if (
      e.type !== "workflow.run.completed" ||
      !e.conversationId ||
      e.payload["status"] !== "succeeded"
    ) {
      continue;
    }
    if (e.payload["isTest"] === true) continue;
    let cronKey: string | null = null;
    if (e.payload["triggerType"] === "cron") {
      const workflowId = e.payload["workflowId"];
      if (typeof workflowId === "string") {
        cronKey = `workflow-distill-cron:${workflowId}`;
        const acquired = await redis.set(
          cronKey,
          "1",
          "EX",
          CRON_DISTILL_TTL_S,
          "NX",
        );
        // Already distilled a cron run for this workflow inside the window.
        if (acquired !== "OK") continue;
      }
    }
    const jobId = `distill-${e.conversationId}`;
    await distillQueue.remove(jobId).catch(() => {});
    try {
      await distillQueue.add(
        "distill",
        {
          conversationId: e.conversationId,
          organizationId: e.organizationId,
          teamId: e.teamId,
        },
        {
          jobId,
          attempts: 3,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: { count: 500 },
          removeOnFail: { count: 500 },
        },
      );
    } catch (err) {
      // Give the 24h cron slot back before failing the sweep — the cursor
      // has not advanced, so the replayed batch re-acquires it and retries.
      if (cronKey) await redis.del(cronKey).catch(() => {});
      throw err;
    }
  }

  // Record-card refreshes. One pending op per record, in event order — a
  // create/update/confirm requests a debounced re-embed; a delete/reject
  // requests an immediate vector drop and cancels any pending upsert
  // (shared `card-{recordId}` jobId + remove-then-add). `record.deleted`
  // carries the id in its payload (the record row — and with it
  // `subjectRecordId` — is already gone).
  const cardOps = new Map<
    string,
    { op: "upsert" | "delete"; organizationId: string; teamId: string }
  >();
  for (const e of events) {
    const scope = { organizationId: e.organizationId, teamId: e.teamId };
    if (
      (e.type === "record.created" ||
        e.type === "record.updated" ||
        e.type === "record.confirmed") &&
      e.subjectRecordId
    ) {
      cardOps.set(e.subjectRecordId, { op: "upsert", ...scope });
    } else if (e.type === "record.rejected" && e.subjectRecordId) {
      cardOps.set(e.subjectRecordId, { op: "delete", ...scope });
    } else if (e.type === "record.deleted") {
      const recordId = e.payload["recordId"];
      if (typeof recordId === "string") {
        cardOps.set(recordId, { op: "delete", ...scope });
      }
    }
  }
  const cardQueue = getRecordCardQueue();
  for (const [recordId, { op, ...scope }] of cardOps) {
    const jobId = `card-${recordId}`;
    await cardQueue.remove(jobId).catch(() => {});
    // Not caught — same rationale as the distill adds above.
    await cardQueue.add(
      "card",
      { recordId, op, ...scope },
      {
        jobId,
        ...(op === "upsert" ? { delay: CARD_DEBOUNCE_MS } : {}),
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 1_000 },
      },
    );
  }

  const last = events[events.length - 1];
  if (last) {
    await advanceWorkerCursor({ name: CURSOR_NAME, position: last.id });
  }
  return { swept: events.length };
};
