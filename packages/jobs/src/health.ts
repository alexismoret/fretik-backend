import { getDocumentVectorRefreshQueue } from "@fretik/shared/services/documents/vector-refresh-queue";
import { listWorkerCursors } from "@fretik/shared/services/domain-events/consume";
import { Hono } from "hono";
import {
  getMemoryDistillQueue,
  getMemoryDreamingQueue,
  getMemoryMaintenanceQueue,
  getMemoryResolveQueue,
  getModelSyncQueue,
  getRecordCardQueue,
  getVectorReconcileQueue,
} from "./queues/queues";

/**
 * Liveness + introspection: queue depths and journal-cursor freshness. The
 * cursor's `updatedAt` age is the sweep lag signal (a healthy idle journal
 * still advances `updatedAt` only when events flow — pair it with the wait
 * counts to tell "idle" from "stuck").
 */
export const healthApp = new Hono();

healthApp.get("/health", async (c) => {
  const [
    resolve,
    distill,
    card,
    dreaming,
    maintenance,
    docVectors,
    vectorReconcile,
    modelSync,
    cursors,
  ] = await Promise.all([
    getMemoryResolveQueue().getJobCounts("wait", "active", "failed"),
    getMemoryDistillQueue().getJobCounts("wait", "active", "delayed", "failed"),
    getRecordCardQueue().getJobCounts("wait", "active", "delayed", "failed"),
    getMemoryDreamingQueue().getJobCounts("wait", "active", "failed"),
    getMemoryMaintenanceQueue().getJobCounts("wait", "active", "failed"),
    // The two vector-maintenance queues. Both retain their terminal jobs, so a
    // non-zero `failed` here is the only place a dropped index becomes visible.
    getDocumentVectorRefreshQueue().getJobCounts(
      "wait",
      "active",
      "delayed",
      "failed",
    ),
    getVectorReconcileQueue().getJobCounts("wait", "active", "failed"),
    // One job a night: `active` here outside the 00:30 window means a pass is
    // still crawling hours later, and a non-zero `failed` means both attempts
    // lost — the fleet is routing on yesterday's catalogue either way.
    getModelSyncQueue().getJobCounts("wait", "active", "delayed", "failed"),
    listWorkerCursors(),
  ]);
  return c.json({
    status: "ok",
    queues: {
      "memory-resolve": resolve,
      "memory-distill": distill,
      "record-card": card,
      "memory-dreaming": dreaming,
      "memory-maintenance": maintenance,
      "document-vector-refresh": docVectors,
      "vector-reconcile": vectorReconcile,
      "model-sync": modelSync,
    },
    cursors: cursors.map((cur) => ({
      name: cur.name,
      position: cur.position,
      updatedAt: cur.updatedAt.toISOString(),
      ageMs: Date.now() - cur.updatedAt.getTime(),
    })),
  });
});
