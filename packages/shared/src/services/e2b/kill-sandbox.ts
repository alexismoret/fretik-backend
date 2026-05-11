import { Sandbox } from "@e2b/code-interpreter";
import { clearPythonContextFromRegistry } from "./python-context-registry";
import { clearSandboxFromRegistry, getSandboxIdFromRegistry } from "./registry";

/**
 * Destroy the conversation's sandbox. Called from:
 * - the `bash` tool's `restart: true` path,
 * - the API's DELETE conversation handler,
 * - the nightly orphan-cleanup cron.
 *
 * Always clears the Redis registry so the next `acquireSandbox` is a
 * fresh `Sandbox.create`. Belt-and-braces fallback: if Redis didn't
 * have the mapping, list by metadata and kill any orphans we find.
 */
export const killSandbox = async (conversationId: string): Promise<void> => {
  const sandboxId = await getSandboxIdFromRegistry(conversationId);
  // The Python context lives inside the sandbox kernel — once the
  // sandbox is gone the contextId is dead. Clear the registry first
  // so a concurrent runInSandbox call doesn't pick up a stale entry.
  await clearPythonContextFromRegistry(conversationId);
  await clearSandboxFromRegistry(conversationId);

  if (sandboxId) {
    try {
      await Sandbox.kill(sandboxId);
    } catch (err) {
      console.warn(
        `[e2b:kill] kill failed for sandbox ${sandboxId} (conv ${conversationId}):`,
        err instanceof Error ? err.message : err,
      );
    }
    return;
  }

  // No Redis entry — sweep up any leftover sandbox tagged with this
  // conversationId. Failures are best-effort and logged. The paginator
  // advances its cursor only when `nextItems()` is awaited, so we MUST
  // await inside the loop — collecting unresolved promises would leave
  // `hasNext` stuck at `true` and spin forever (allocating promises +
  // network requests until the heap is exhausted).
  try {
    const paginator = Sandbox.list({
      query: { metadata: { conversationId } },
    });
    /* oxlint-disable no-await-in-loop -- paginator cursor advances on await */
    while (paginator.hasNext) {
      const orphans = await paginator.nextItems();
      await Promise.all(
        orphans.map((s) =>
          Sandbox.kill(s.sandboxId).catch((err: unknown) => {
            console.warn(
              `[e2b:kill] orphan kill failed for ${s.sandboxId}:`,
              err instanceof Error ? err.message : err,
            );
          }),
        ),
      );
    }
    /* oxlint-enable no-await-in-loop */
  } catch (err) {
    console.warn(
      `[e2b:kill] orphan sweep failed for conv ${conversationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
};
