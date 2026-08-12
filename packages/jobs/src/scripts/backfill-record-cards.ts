import db from "@fretik/shared/db";
import { isCardIndexedType } from "@fretik/shared/services/object-records/card-indexing-policy";
import { getRecordCardQueue } from "../queues/queues";

/**
 * One-shot backfill: enqueue a card upsert for every confirmed non-mirror
 * record, newest first (mirrors are excluded here to save jobs, and
 * `buildRecordCard` re-guards anyway). Rate is capped by the record-card
 * worker's concurrency; stopping = draining the queue. Existing jobIds
 * (`card-{id}`) make re-runs no-ops for records already pending.
 *
 * Types the size policy excludes are dropped HERE too, not only in
 * `buildRecordCard`: a backfill over a 200 000-row type would otherwise queue
 * 200 000 jobs for the worker to discard one by one, which is the throughput
 * cost the policy exists to avoid even though the end state would be right.
 *
 *   bun run backfill:record-cards [--limit N] [--dry-run]
 */

const DEFAULT_LIMIT = 200;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const limitFlagIndex = argv.indexOf("--limit");
const limitRaw =
  limitFlagIndex === -1
    ? Number.NaN
    : Number.parseInt(argv[limitFlagIndex + 1] ?? "", 10);
const limit =
  Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_LIMIT;

const candidates = await db.query.objectRecords.findMany({
  columns: {
    id: true,
    teamId: true,
    organizationId: true,
    objectTypeId: true,
    label: true,
  },
  where: { status: "confirmed", documentId: { isNull: true } },
  orderBy: { updatedAt: "desc" },
  limit,
});

// One verdict per distinct type, not per record — the policy caches, but this
// also keeps the log honest about WHY rows were dropped.
const indexedTypes = new Map<string, boolean>();
for (const typeId of new Set(candidates.map((row) => row.objectTypeId))) {
  indexedTypes.set(typeId, await isCardIndexedType(typeId));
}
const rows = candidates.filter(
  (row) => indexedTypes.get(row.objectTypeId) === true,
);
const excluded = candidates.length - rows.length;

console.info(
  `[backfill-record-cards] ${rows.length.toString()} confirmed records (limit ${limit.toString()}${excluded > 0 ? `, ${excluded.toString()} skipped — type not semantically indexed` : ""}${dryRun ? ", dry-run" : ""})`,
);

if (dryRun) {
  for (const row of rows) {
    console.info(`- ${row.id} — ${row.label}`);
  }
  process.exit(0);
}

const queue = getRecordCardQueue();
await queue.addBulk(
  rows.map((row) => ({
    name: "card",
    data: {
      recordId: row.id,
      organizationId: row.organizationId,
      teamId: row.teamId,
      op: "upsert" as const,
    },
    opts: {
      jobId: `card-${row.id}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 1_000 },
      removeOnFail: { count: 1_000 },
    },
  })),
);
console.info(
  `[backfill-record-cards] enqueued ${rows.length.toString()} card jobs`,
);
await queue.close();
process.exit(0);
