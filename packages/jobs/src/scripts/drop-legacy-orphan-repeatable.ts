import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";

/**
 * One-shot cleanup that MUST run before BullMQ 6 is deployed.
 *
 * `chat-files-maintenance` was the last queue still driven by the legacy
 * repeatable API (`queue.add(..., { repeat })`). BullMQ 6 removed that API and
 * does not ignore its leftovers — it throws `Legacy repeatable job metadata is
 * not supported in BullMQ v6` on encountering them, so the @fretik/ai
 * container would fail to boot with the metadata still in Redis.
 *
 * Written against raw Redis rather than the Queue class on purpose: the
 * methods that would express this (`getRepeatableJobs`,
 * `removeRepeatableByKey`) are themselves part of the API v6 removed, so a
 * Queue-based version could not compile once the repo is on v6 — which is
 * exactly when this still needs to be runnable.
 *
 * How legacy entries are told apart from Job Schedulers: both live in the same
 * `<prefix>:<queue>:repeat` sorted set, so membership proves nothing. A
 * scheduler additionally writes an `ic` (iteration count) field into its
 * `repeat:<id>` hash; the legacy `addRepeatableJob` flow never does. That is
 * the same probe BullMQ 6 itself uses to disambiguate.
 *
 * Idempotent, and safe to run on either version.
 *
 * Run: `bun --env-file=.env run src/scripts/drop-legacy-orphan-repeatable.ts`
 */
const QUEUE_NAME = "chat-files-maintenance";
const PREFIX = "bull"; // BullMQ default; no queue here overrides it

const run = async (): Promise<void> => {
  // The patient connection, not the producer one: the producer is built with
  // `enableOfflineQueue: false` so that a request-path enqueue fails fast, and
  // it rejects any command issued before the socket is ready. A one-shot
  // maintenance script has nobody waiting on a 503 and should just connect.
  const redis = createWorkerConnection();
  const base = `${PREFIX}:${QUEUE_NAME}`;

  const members = await redis.zrange(`${base}:repeat`, 0, -1);
  if (members.length === 0) {
    console.log(`[cleanup] \`${QUEUE_NAME}\` has no repeat entries at all`);
  }

  let removed = 0;
  for (const id of members) {
    // eslint-disable-next-line no-await-in-loop -- single-digit list, and the
    // sequential log is the point: this runs once, by hand, before a deploy.
    const isScheduler = await redis.hexists(`${base}:repeat:${id}`, "ic");
    if (isScheduler === 1) {
      console.log(`[cleanup] keeping job scheduler \`${id}\``);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await redis
      .multi()
      .zrem(`${base}:repeat`, id)
      .del(`${base}:repeat:${id}`)
      .exec();
    removed++;
    console.log(`[cleanup] removed legacy repeatable \`${id}\``);
  }

  const left = await redis.zrange(`${base}:repeat`, 0, -1);
  console.log(
    `[cleanup] removed ${removed.toString()} legacy entr(y|ies); ${left.length.toString()} scheduler(s) remain: ${left.join(", ") || "<none>"}`,
  );
  console.log(
    "[cleanup] @fretik/ai re-creates its scheduler on boot; deploy BullMQ 6 only once this reports 0 legacy entries",
  );

  process.exit(0);
};

run().catch((error: unknown) => {
  console.error("[cleanup] failed:", error);
  process.exit(1);
});
