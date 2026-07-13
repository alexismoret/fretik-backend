import { introspectMcpConnection } from "@fretik/providers/mcp";
import { createWorkerConnection } from "@fretik/shared/lib/queue/connection";
import { listActiveMcpConnections } from "@fretik/shared/services/external-apps/mcp/list-active-mcp-connections";
import { type Job, Worker } from "bullmq";
import { MCP_REFRESH_QUEUE, MCP_SNAPSHOT_REFRESH_JOB } from "../queues/names";

/**
 * Nightly MCP tool-snapshot drift refresh. Re-introspects every active MCP
 * connection: `introspectMcpConnection` re-lists `tools/list`, recompiles the
 * snapshot, and (get-or-insert by fingerprint) points the connection at it —
 * so an unchanged surface is a cheap no-op and a changed one is auto-adopted.
 * The next conversation's sandbox bootstrap picks up the fresh stub; a running
 * conversation keeps the surface it booted with, so adoption never breaks a
 * live turn. (Pinning breaking changes + notifying admins is a later
 * refinement — auto-adopt is the safe default.)
 *
 * A single server being down/slow must not abort the sweep, so each connection
 * is introspected independently and its failure only skips that one.
 */
export const runMcpSnapshotRefresh = async (): Promise<{
  checked: number;
  changed: number;
  failed: number;
}> => {
  const connections = await listActiveMcpConnections();
  let changed = 0;
  let failed = 0;

  for (const connection of connections) {
    const before = connection.toolFingerprint;
    try {
      // eslint-disable-next-line no-await-in-loop -- bounded nightly sweep, low N; sequential keeps Nango load flat
      const { fingerprint } = await introspectMcpConnection(connection);
      if (fingerprint !== before) {
        changed++;
        console.info(
          `[mcp-refresh] ${connection.providerKey} (${connection.id}) drift ${before ?? "none"} → ${fingerprint}`,
        );
      }
    } catch (error) {
      failed++;
      // The connection keeps its last-good snapshot (fingerprint unchanged), so
      // a transient refresh failure never breaks a working app — just log. A
      // still-`preparing` connection is simply retried next run; on success
      // `setConnectionToolFingerprint` clears any recorded error.
      console.error(
        `[mcp-refresh] introspection failed for ${connection.providerKey} (${connection.id}); snapshot left as-is:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { checked: connections.length, changed, failed };
};

export const startMcpRefreshWorker = (): Worker => {
  const worker = new Worker(
    MCP_REFRESH_QUEUE,
    async (job: Job) => {
      if (job.name !== MCP_SNAPSHOT_REFRESH_JOB) {
        console.warn(`[mcp-refresh] unknown job "${job.name}"`);
        return;
      }
      const { checked, changed, failed } = await runMcpSnapshotRefresh();
      console.info(
        `[mcp-refresh] checked ${checked.toString()} · adopted ${changed.toString()} · failed ${failed.toString()}`,
      );
    },
    { connection: createWorkerConnection(), concurrency: 1 },
  );
  worker.on("failed", (job, err) => {
    console.error(
      `[mcp-refresh] job ${job?.name ?? "<unknown>"} failed:`,
      err instanceof Error ? err.message : err,
    );
  });
  return worker;
};
