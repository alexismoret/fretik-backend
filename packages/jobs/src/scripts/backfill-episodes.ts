import db from "@fretik/shared/db";
import { assertOperatorTarget } from "@fretik/shared/lib/operator-guard";
import { getMemoryDistillQueue } from "../queues/queues";

/**
 * One-shot backfill: enqueue a distill job for existing conversations,
 * newest first. Short conversations are cheap no-ops — the distiller's own
 * MIN_MESSAGES skip fires before any LLM call. Rate is capped by the
 * memory-distill worker's concurrency (the LLM calls), not by this
 * producer; stopping = draining the queue. Existing jobIds
 * (`distill-{id}`) make re-runs no-ops for conversations already pending.
 *
 *   bun run backfill:episodes [--limit N] [--dry-run]
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

await assertOperatorTarget(Bun.argv);

const rows = await db.query.aiConversations.findMany({
  columns: { id: true, teamId: true, organizationId: true, title: true },
  orderBy: { updatedAt: "desc" },
  limit,
});

console.info(
  `[backfill-episodes] ${rows.length.toString()} conversations (limit ${limit.toString()}${dryRun ? ", dry-run" : ""})`,
);

if (dryRun) {
  for (const row of rows) {
    console.info(`- ${row.id} — ${row.title}`);
  }
  process.exit(0);
}

const queue = getMemoryDistillQueue();
await queue.addBulk(
  rows.map((row) => ({
    name: "distill",
    data: {
      conversationId: row.id,
      organizationId: row.organizationId,
      teamId: row.teamId,
    },
    opts: {
      jobId: `distill-${row.id}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 500 },
    },
  })),
);
console.info(
  `[backfill-episodes] enqueued ${rows.length.toString()} distill jobs`,
);
await queue.close();
process.exit(0);
