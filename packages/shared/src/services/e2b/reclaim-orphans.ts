import { Sandbox } from "@e2b/code-interpreter";
import { getSandboxIdFromRegistry } from "./registry";

/**
 * Sweep E2B for sandboxes that are still alive on E2B's side but no
 * longer match a live conversation in our Redis registry. A sandbox is
 * considered orphan when its `metadata.conversationId` either has no
 * Redis entry (TTL expired = conversation idle past
 * `SANDBOX_REGISTRY_TTL_S`) or maps to a different sandbox id (stale
 * sandbox the registry rotated past).
 *
 * Called from two triggers, neither of which is a BullMQ cron:
 * - **boot**: once at AI server start (covers dev hot-reloads and
 *   restarts that orphan sandboxes from a previous run),
 * - **release-throttled**: at the end of `releaseSandbox`, gated by a
 *   30-min Redis SETNX so at most one instance sweeps per window.
 *
 * Best-effort throughout: any failure is logged and execution
 * continues so a single bad sandbox can't block the rest of the sweep.
 */
export const reclaimOrphanSandboxes = async (): Promise<void> => {
  const paginator = Sandbox.list({});
  /* oxlint-disable no-await-in-loop -- paginator cursor advances on await */
  while (paginator.hasNext) {
    const page = await paginator.nextItems();
    for (const info of page) {
      const conversationId = info.metadata?.conversationId;
      if (!conversationId) continue; // not ours — leave it alone

      const cached = await getSandboxIdFromRegistry(conversationId);
      if (cached === info.sandboxId) continue; // legitimate, in use

      // Either Redis is empty (conversation idle past TTL) or it
      // points at a different sandbox (this one is stale).
      console.warn(
        `[e2b:reclaim] killing orphan sandbox=${info.sandboxId} state=${info.state} conversationId=${conversationId}`,
      );
      try {
        await Sandbox.kill(info.sandboxId);
      } catch (err) {
        console.warn(
          `[e2b:reclaim] kill failed for ${info.sandboxId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  /* oxlint-enable no-await-in-loop */
};
