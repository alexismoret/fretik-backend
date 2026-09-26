import { acquireSandbox } from "./acquire-sandbox";
import {
  clearPythonContextFromRegistry,
  getPythonContextFromRegistry,
} from "./python-context-registry";
import { getSandboxIdFromRegistry } from "./registry";

/**
 * Remove a scoped Jupyter kernel once its owner is done with it — the end of
 * a sub-agent run.
 *
 * Each kernel is a process in a 1.5 GB sandbox, and a sub-agent that loaded a
 * spreadsheet into pandas leaves that memory behind. Left alone, a
 * conversation that dispatches a handful of analyses would fill the sandbox
 * with idle kernels the parent then has to share memory with.
 *
 * Best-effort and cheap when there is nothing to do: a run that never called
 * `python` has no registry entry and returns after one Redis read, and a
 * sandbox that was recycled since took the kernel with it. It never resumes a
 * paused sandbox just to clean it.
 */
export const releasePythonContext = async (
  conversationId: string,
  scope: string,
): Promise<void> => {
  const cached = await getPythonContextFromRegistry(conversationId, scope);
  if (cached === null) return;
  await clearPythonContextFromRegistry(conversationId, scope);
  const liveSandboxId = await getSandboxIdFromRegistry(conversationId);
  if (liveSandboxId !== cached.sandboxId) return;
  try {
    const lease = await acquireSandbox(conversationId);
    if (lease.sandboxId !== cached.sandboxId) return;
    await lease.sandbox.removeCodeContext(cached.contextId);
  } catch (err) {
    console.warn(
      `[e2b:release-kernel] removeCodeContext failed for ${cached.contextId} (conv ${conversationId}):`,
      err instanceof Error ? err.message : err,
    );
  }
};
