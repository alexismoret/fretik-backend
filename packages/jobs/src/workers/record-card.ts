import { callAiService } from "@fretik/shared/lib/ai-service";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { buildRecordCard } from "@fretik/shared/services/object-records/build-card";
import { deleteRecordCardVectors } from "@fretik/shared/services/object-records/card-vectors";
import { type Job, Worker } from "bullmq";
import { z } from "zod";
import { RECORD_CARD_QUEUE, type RecordCardJobData } from "../queues/names";

/**
 * Record-card indexer (P4). `upsert` rebuilds the record's semantic card
 * (`buildRecordCard`) and pushes it through `/internal/vectorize`
 * (source_type='records' — the endpoint DELETEs before INSERT, so re-runs
 * are idempotent). A null card (record gone, no longer confirmed, or a
 * document mirror) degrades to a delete: whatever the reason, the card must
 * not sit in the index. `delete` drops the vectors directly — nothing to
 * embed, no AI-service roundtrip.
 */

const CONCURRENCY = 3;

const vectorizeResponseSchema = z.object({ success: z.boolean() });

const processCard = async (data: RecordCardJobData): Promise<void> => {
  if (data.op === "delete") {
    await deleteRecordCardVectors(data.recordId);
    return;
  }
  const card = await buildRecordCard(data.recordId);
  if (!card) {
    await deleteRecordCardVectors(data.recordId);
    return;
  }
  await callAiService(
    "/internal/vectorize",
    {
      sourceType: "records",
      sourceId: data.recordId,
      content: card.content,
      metadata: card.metadata,
      // Scope comes from the fresh record row, not the (possibly stale)
      // job payload — the payload's ids only route the internal call.
      teamId: card.teamId,
      organizationId: card.organizationId,
    },
    vectorizeResponseSchema,
    { teamId: card.teamId, organizationId: card.organizationId },
  );
};

export const startRecordCardWorker = (): Worker<RecordCardJobData> => {
  const worker = new Worker<RecordCardJobData>(
    RECORD_CARD_QUEUE,
    (job: Job<RecordCardJobData>) => processCard(job.data),
    { connection: createWorkerConnection(), concurrency: CONCURRENCY },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[record-card] job ${job?.id ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
