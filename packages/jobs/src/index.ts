// Compiles every Zod schema on first use (zod 4.5). Side-effect import, first
// so nothing parses ahead of it. Valid input takes the compiled path, invalid
// input falls back to the normal parser, so error reporting is unchanged.
import "zod/compile";

import {
  assertMigrationsCurrent,
  runMigrationsWithLock,
} from "@fretik/shared/db/migrations";
import { startBulkOperationWorker } from "@fretik/shared/services/bulk-operations/queue";
import { startDocumentProcessingWorker } from "@fretik/shared/services/documents/processing-queue";
import { startDocumentVectorRefreshWorker } from "@fretik/shared/services/documents/vector-refresh-queue";
import packagejson from "../package.json";
import { healthApp } from "./health";
import { registerSchedulers } from "./queues/schedulers";
import { startCollectionIndexWorker } from "./workers/collection-index-sweep";
import { startDreamingWorker } from "./workers/dreaming";
import { startMaintenanceWorker } from "./workers/maintenance";
import { startMcpRefreshWorker } from "./workers/mcp-refresh";
import { startMemoryDistillWorker } from "./workers/memory-distill";
import { startMemoryResolveWorker } from "./workers/memory-resolve";
import { startModelSyncWorker } from "./workers/model-sync";
import { startRecordCardWorker } from "./workers/record-card";
import { startVectorReconcileWorker } from "./workers/vector-reconcile";
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

// Migrations are a deployment step, never an import side effect — see
// `@fretik/shared/db/migrations` for the production incident that rule comes
// from. This file used to import `@fretik/shared/db` FOR that side effect,
// which is how a laptop script running the same code could migrate whatever
// `DATABASE_URL` pointed at. Exactly one of two things is now true of every
// process: the deployment opted in and this container migrates under the
// advisory lock, or it refuses to run workers against a schema older than its
// own code.
if (process.env.RUN_MIGRATIONS === "true") {
  await runMigrationsWithLock({ kind: "service-boot" });
} else {
  await assertMigrationsCurrent("jobs");
}

startDocumentProcessingWorker();
startDocumentVectorRefreshWorker();
startMemoryResolveWorker();
startMemoryDistillWorker();
startRecordCardWorker();
startDreamingWorker();
startWorkflowRunCreateWorker();
startMaintenanceWorker();
startMcpRefreshWorker();
startCollectionIndexWorker();
startVectorReconcileWorker();
startModelSyncWorker();
startBulkOperationWorker();
await registerSchedulers();

console.log(`
---------------------------
fretik jobs v${packagejson.version}
workers: document-processing · document-vector-refresh · memory-resolve · memory-distill · record-card · memory-dreaming · memory-maintenance · workflow-trigger · mcp-refresh · collection-index · vector-reconcile · model-sync · bulk-operation
---------------------------
`);

export default {
  port: process.env.PORT ?? 8084,
  fetch: healthApp.fetch,
  idleTimeout: 30,
};
