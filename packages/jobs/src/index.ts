// Importing the db module runs `runMigrationsWithLock()` at load — behind a
// Postgres advisory lock, so booting jobs + api + ai in parallel is safe.
import "@fretik/shared/db";

import { startDocumentProcessingWorker } from "@fretik/shared/services/documents/processing-queue";
import packagejson from "../package.json";
import { healthApp } from "./health";
import { registerSchedulers } from "./queues/schedulers";
import { startDreamingWorker } from "./workers/dreaming";
import { startMaintenanceWorker } from "./workers/maintenance";
import { startMemoryDistillWorker } from "./workers/memory-distill";
import { startMemoryResolveWorker } from "./workers/memory-resolve";
import { startRecordCardWorker } from "./workers/record-card";
import { startWorkflowRunCreateWorker } from "./workers/workflow-run-create";

/**
 * @fretik/jobs — the background-jobs process (BullMQ over the shared Redis).
 * Hosts the high-volume infra plumbing: the document-processing pipeline
 * (moved out of the API replicas), the memory pipeline (journal sweep →
 * resolve → distill, plus the nightly dreaming + GC crons), and the workflow
 * event-trigger bridge (trigger sweep → run creation). The Trigger.dev
 * orchestrator lives in its own package — both rails meet in the
 * `domain_events` journal.
 */

startDocumentProcessingWorker();
startMemoryResolveWorker();
startMemoryDistillWorker();
startRecordCardWorker();
startDreamingWorker();
startWorkflowRunCreateWorker();
startMaintenanceWorker();
await registerSchedulers();

console.log(`
---------------------------
fretik jobs v${packagejson.version}
workers: document-processing · memory-resolve · memory-distill · record-card · memory-dreaming · memory-maintenance · workflow-trigger
---------------------------
`);

export default {
  port: process.env.PORT ?? 8084,
  fetch: healthApp.fetch,
  idleTimeout: 30,
};
