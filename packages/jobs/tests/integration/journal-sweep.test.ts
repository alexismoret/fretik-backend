import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { redis } from "@fretik/shared/lib/redis";
import { ensureWorkerCursor } from "@fretik/shared/services/domain-events/consume";
import { emitDomainEvent } from "@fretik/shared/services/domain-events/emit";
import { Worker, type Job, type Queue } from "bullmq";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { RECORD_CARD_QUEUE } from "../../src/queues/names";

import {
  createJobsTestFixture,
  type JobsTestFixture,
} from "../lib/db-fixtures";
import { rejection } from "../lib/expect-rejection";
import { assertDisposableRedis } from "../lib/integration-guard";

/**
 * The journal sweep's Redis half — the part no double can stand in for.
 *
 * Everything interesting here is a property of BullMQ's key space rather than
 * of this code's control flow:
 *
 *  - `add` is REFUSED when a job with that id exists in ANY state, completed
 *    included, and both queues retain completed jobs. So the remove-then-add in
 *    `resetDebounce` is not an optimisation, it is the difference between a
 *    record being re-indexed and never being re-indexed again. The comment
 *    above it says "verified against a live Redis" — that verification was a
 *    person, once, in 2026. This is that verification, kept.
 *  - a debounced job's `delay` has to be PUSHED BACK by a later turn, not
 *    merely left standing, or a long conversation distills mid-flow.
 *  - the cron `SET NX` slot and the compensating `del` on a failed enqueue are
 *    a hand-rolled transaction across two systems.
 *
 * A fake queue would answer all of it from whatever the fake was written to
 * believe. So: a real Postgres, a real Redis, real BullMQ. Only the AI service
 * is doubled, and only because nothing here consumes the jobs — the assertions
 * are about what is IN the queue, not what a worker would do with it.
 *
 * The watermark is turned down before the worker is imported: it reads its
 * interval once at module load, and the default 15s would make every event this
 * file writes invisible to the sweep that follows it. `1`, not `0` — every knob
 * in `lib/env.ts` treats zero and negative as "malformed" and silently returns
 * the default, so asking for no watermark at all gets you the full 15 seconds.
 */

process.env["MEMORY_SWEEP_WATERMARK_MS"] = "1";
process.env["MEMORY_CRON_DISTILL_TTL_S"] = "60";
// Still a real debounce (the delay assertions below depend on it being > 0),
// short enough that a worker can reach the job inside a test.
process.env["MEMORY_CARD_DEBOUNCE_MS"] = "1";

const { runJournalSweep } = await import("../../src/workers/journal-sweep");
const { getMemoryDistillQueue, getMemoryResolveQueue, getRecordCardQueue } =
  await import("../../src/queues/queues");

let fx: JobsTestFixture;

const jobIn = async (queue: Queue, jobId: string): Promise<Job | undefined> =>
  (await queue.getJob(jobId)) ?? undefined;

/** Poll until a job reaches a state, or give up loudly rather than hang. */
const waitForState = async (
  queue: Queue,
  jobId: string,
  state: string,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const actual = await (await jobIn(queue, jobId))?.getState();
    if (actual === state) return;
    if (Date.now() > deadline) {
      throw new Error(`job ${jobId} was "${actual ?? "gone"}", not "${state}"`);
    }
    await Bun.sleep(50);
  }
};

beforeAll(async () => {
  await assertDisposableRedis(redis);
  // Create the cursor BEFORE the first event exists. `ensureWorkerCursor`
  // starts a brand-new consumer at the journal's current TAIL — historical
  // events are somebody else's problem — so a test that emits first and sweeps
  // second would have its own event land exactly on the tail the cursor was
  // just created at, and be skipped. In production the cursor long predates
  // the events; here it has to be made to.
  await ensureWorkerCursor("memory-resolver");
  fx = await createJobsTestFixture();
});

afterAll(async () => {
  await fx.cleanup();
  // Scoped to these three queues by name — never a FLUSHDB, which would take
  // the marker key and anything else sharing the instance with it.
  await getMemoryDistillQueue().obliterate({ force: true });
  await getMemoryResolveQueue().obliterate({ force: true });
  await getRecordCardQueue().obliterate({ force: true });
  await redis.del("fretik:integration-scratch");
});

describe("resolve fan-out", () => {
  test("an event that needs resolution gets one idempotent job", async () => {
    const event = await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "document.uploaded",
      actor: { actorType: "system" },
      payload: { note: "integration" },
    });

    await runJournalSweep();

    const job = await jobIn(getMemoryResolveQueue(), `resolve-${event.id}`);
    expect(job?.data).toMatchObject({
      eventId: event.id,
      teamId: fx.teamId,
      type: "document.uploaded",
    });
  });

  test("a record event is skipped by the resolver but still refreshes its card", async () => {
    // `record.*` is linked at source, so the LLM mention-extraction has nothing
    // to do — but the card indexer does. Two different fan-outs from one event,
    // and the skip list is what separates them.
    const recordId = await fx.createRecord();
    const event = await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "record.created",
      actor: { actorType: "system" },
      subjectRecordId: recordId,
    });

    await runJournalSweep();

    expect(
      await jobIn(getMemoryResolveQueue(), `resolve-${event.id}`),
    ).toBeUndefined();
    expect(await jobIn(getRecordCardQueue(), `card-${recordId}`)).toBeDefined();
  });
});

describe("the debounce, against the key space that defines it", () => {
  test("a second turn REPLACES the pending distill and pushes its delay back", async () => {
    const conversationId = await fx.createConversation();
    const turn = () =>
      emitDomainEvent({
        organizationId: fx.organizationId,
        teamId: fx.teamId,
        type: "chat.turn",
        actor: { actorType: "user", conversationId },
      });

    await turn();
    await runJournalSweep();
    const first = await jobIn(
      getMemoryDistillQueue(),
      `distill-${conversationId}`,
    );
    expect(first).toBeDefined();
    const firstRunAt = (first?.timestamp ?? 0) + (first?.delay ?? 0);

    // BullMQ stamps `timestamp` with `Date.now()`, so two enqueues inside the
    // same millisecond are indistinguishable and the strict comparison below
    // would fail on a fast enough machine — against a local container it very
    // nearly does. Waiting for the clock to move makes the claim measurable
    // instead of racing it. (Weakening the assertion to `>=` would have been
    // the wrong fix: `>=` is also true of a job that was never replaced, which
    // is exactly the defect under test.)
    await Bun.sleep(5);

    await turn();
    await runJournalSweep();
    const second = await jobIn(
      getMemoryDistillQueue(),
      `distill-${conversationId}`,
    );
    expect(second).toBeDefined();
    const secondRunAt = (second?.timestamp ?? 0) + (second?.delay ?? 0);

    // One job, not two — and it now fires later than the first one would have.
    // Left standing instead of replaced, a conversation would distill on a
    // schedule set by its FIRST turn, cutting a long exchange in half.
    expect(secondRunAt).toBeGreaterThan(firstRunAt);
  });

  test("a COMPLETED job does not block the next enqueue — the whole reason remove-then-add exists", async () => {
    // The failure this guards against, reproduced end to end: BullMQ refuses an
    // `add` whose id exists in ANY state, and this queue retains 1 000
    // completed jobs. Without the removal the second sweep is a silent no-op
    // and the record is never re-indexed again until the completed job ages
    // out — no error, no log, just a card that stops being true.
    //
    // The completed state is reached by running a real Worker over the job
    // rather than by forcing the transition: `moveToCompleted` needs the lock a
    // worker holds, and a test that pokes the key space directly would be
    // asserting against a state BullMQ never actually produces.
    const recordId = await fx.createRecord();
    const jobId = `card-${recordId}`;
    const queue = getRecordCardQueue();

    await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "record.created",
      actor: { actorType: "system" },
      subjectRecordId: recordId,
    });
    await runJournalSweep();
    expect(await jobIn(queue, jobId)).toBeDefined();

    const worker = new Worker(
      RECORD_CARD_QUEUE,
      () => Promise.resolve("done"),
      {
        connection: createWorkerConnection(),
      },
    );
    try {
      await waitForState(queue, jobId, "completed");
    } finally {
      await worker.close();
    }

    await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "record.updated",
      actor: { actorType: "system" },
      subjectRecordId: recordId,
    });
    await runJournalSweep();

    const requeued = await jobIn(queue, jobId);
    expect(requeued).toBeDefined();
    expect(await requeued?.getState()).not.toBe("completed");
  });

  test("a delete cancels the pending upsert on the same record, and runs without delay", async () => {
    // One pending op per record, last write wins: an upsert waiting out its
    // debounce must not re-embed a record that has since been deleted. They
    // share a jobId, so the cancellation IS the remove-then-add.
    const recordId = await fx.createRecord();
    const queue = getRecordCardQueue();

    await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "record.created",
      actor: { actorType: "system" },
      subjectRecordId: recordId,
    });
    await runJournalSweep();
    expect((await jobIn(queue, `card-${recordId}`))?.delay).toBeGreaterThan(0);

    await emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "record.deleted",
      actor: { actorType: "system" },
      payload: { recordId },
    });
    await runJournalSweep();

    const job = await jobIn(queue, `card-${recordId}`);
    expect(job?.data).toMatchObject({ recordId, op: "delete" });
    expect(job?.delay).toBe(0);
  });
});

describe("workflow runs distill immediately, under two gates", () => {
  const completed = (
    payload: Record<string, unknown>,
    conversationId: string,
  ) =>
    emitDomainEvent({
      organizationId: fx.organizationId,
      teamId: fx.teamId,
      type: "workflow.run.completed",
      actor: { actorType: "workflow", conversationId },
      payload,
    });

  test("a succeeded run distills with no debounce", async () => {
    const conversationId = await fx.createConversation();
    await completed(
      { status: "succeeded", triggerType: "manual" },
      conversationId,
    );
    await runJournalSweep();

    const job = await jobIn(
      getMemoryDistillQueue(),
      `distill-${conversationId}`,
    );
    expect(job).toBeDefined();
    expect(job?.delay).toBe(0);
  });

  test("a failed run and a test run are not remembered", async () => {
    const failedConv = await fx.createConversation();
    const testConv = await fx.createConversation();
    await completed({ status: "failed", triggerType: "manual" }, failedConv);
    await completed(
      { status: "succeeded", triggerType: "manual", isTest: true },
      testConv,
    );
    await runJournalSweep();

    expect(
      await jobIn(getMemoryDistillQueue(), `distill-${failedConv}`),
    ).toBeUndefined();
    expect(
      await jobIn(getMemoryDistillQueue(), `distill-${testConv}`),
    ).toBeUndefined();
  });

  test("a cron workflow distills once per window, whatever its schedule", async () => {
    // An hourly schedule would otherwise mint ~24 near-identical episodes a
    // day and skew recall toward the crons. The slot is a Redis `SET NX`, so
    // the claim is about a key, not about a branch.
    const workflowId = crypto.randomUUID();
    const first = await fx.createConversation();
    const second = await fx.createConversation();

    await completed(
      { status: "succeeded", triggerType: "cron", workflowId },
      first,
    );
    await runJournalSweep();
    expect(
      await jobIn(getMemoryDistillQueue(), `distill-${first}`),
    ).toBeDefined();

    await completed(
      { status: "succeeded", triggerType: "cron", workflowId },
      second,
    );
    await runJournalSweep();
    expect(
      await jobIn(getMemoryDistillQueue(), `distill-${second}`),
    ).toBeUndefined();

    // …and the window is per workflow, not global.
    const other = await fx.createConversation();
    await completed(
      {
        status: "succeeded",
        triggerType: "cron",
        workflowId: crypto.randomUUID(),
      },
      other,
    );
    await runJournalSweep();
    expect(
      await jobIn(getMemoryDistillQueue(), `distill-${other}`),
    ).toBeDefined();
  });

  test("the cron slot is given back when the enqueue fails", async () => {
    // The compensating `del`: the sweep throws, so the cursor does not advance
    // and the batch replays — and the replay has to be able to re-acquire the
    // slot it just burned. Without the rollback the run is lost for 24 hours
    // and nothing says so.
    const workflowId = crypto.randomUUID();
    const conversationId = await fx.createConversation();
    const cronKey = `workflow-distill-cron:${workflowId}`;
    const queue = getMemoryDistillQueue();
    const realAdd = queue.add.bind(queue);
    queue.add = () => Promise.reject(new Error("redis went away"));

    await completed(
      { status: "succeeded", triggerType: "cron", workflowId },
      conversationId,
    );
    try {
      const err = await rejection(runJournalSweep());
      expect(err.message).toContain("redis went away");
    } finally {
      queue.add = realAdd;
    }
    expect(await redis.get(cronKey)).toBeNull();

    // The replay now succeeds, which is the whole point of giving it back.
    await runJournalSweep();
    expect(await jobIn(queue, `distill-${conversationId}`)).toBeDefined();
    await redis.del(cronKey);
  });
});
