import { Sandbox } from "@e2b/code-interpreter";
import { acquireSandbox } from "./acquire-sandbox";
import {
  clearPythonContextFromRegistry,
  getPythonContextFromRegistry,
} from "./python-context-registry";

/**
 * Restart the conversation's Jupyter kernel WITHOUT killing the
 * sandbox. Wipes in-memory variables, imports, function definitions,
 * monkey-patches, etc. — preserves `/workspace`, mounted volumes, and
 * any background processes spawned via `commands.run`.
 *
 * Distinct from `killSandbox` (used by the `bash` tool's
 * `restart: true`): that one nukes the entire E2B sandbox, including
 * `/workspace`. Use this kernel-only restart when the model wants a
 * clean Python state (after a corrupted import, a runaway monkey-patch,
 * or to clear a large object out of memory) but still needs the files
 * it has produced so far.
 *
 * Implementation notes:
 *
 * 1. We always `clearPythonContextFromRegistry` first so the next
 *    `runInSandbox` call recreates a fresh `Context` rather than
 *    dialing the (possibly invalidated) restarted one. Even if the
 *    `restartCodeContext` call below fails, the registry stays clean.
 * 2. If no context has ever been created for this conversation, the
 *    Redis lookup returns null and there is nothing to restart on the
 *    server — we return early. The next `runInSandbox` will spin up a
 *    brand new context anyway.
 * 3. `acquireSandbox` is idempotent and resumes a paused sandbox if
 *    needed; calling it here keeps the conversation's existing E2B
 *    instance alive (and refreshes the timeout).
 */
export const restartPythonKernel = async (
  conversationId: string,
): Promise<void> => {
  const cached = await getPythonContextFromRegistry(conversationId);
  // Always invalidate the cache, even on the no-op path — keeps the
  // invariant simple ("after restart, no cached context survives").
  await clearPythonContextFromRegistry(conversationId);

  if (!cached) return;

  const lease = await acquireSandbox(conversationId);
  // Stale cache (sandbox recycled since the context was created) — the
  // contextId is dead anyway. We've already cleared the registry; the
  // next `runInSandbox` will mint a fresh context against the new
  // sandbox. Nothing to ask the kernel to restart.
  if (cached.sandboxId !== lease.sandboxId) return;

  const sbx = await Sandbox.connect(lease.sandboxId);
  try {
    await sbx.restartCodeContext(cached.contextId);
  } catch (err) {
    // The cached context may have died on the server (kernel crashed,
    // daemon restarted). Logging + best-effort: the registry is already
    // cleared so the next call will create a new context.
    console.warn(
      `[e2b:restart-kernel] restartCodeContext failed for ${cached.contextId} (conv ${conversationId}):`,
      err instanceof Error ? err.message : err,
    );
  }
};
