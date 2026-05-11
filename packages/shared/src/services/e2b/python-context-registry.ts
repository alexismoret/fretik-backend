import { redis } from "../../lib/redis";
import { SANDBOX_REGISTRY_TTL_S } from "./client";

/**
 * Redis-backed registry of `conversationId → { contextId, sandboxId }`
 * for the Jupyter "code context" we create on the E2B daemon with
 * `cwd: "/workspace"`.
 *
 * Why Redis (and not in-memory): @fretik/ai runs as multiple replicas
 * behind a load balancer. A single conversation's tool calls can land
 * on different instances across turns. An in-process Map would force
 * each instance to recreate its own context on first hit, leaking
 * Python kernels on the daemon side and silently splitting variable
 * state across runs even when the model assumes continuity.
 *
 * Storing `{ contextId, sandboxId }` together lets us detect "this
 * cached context belongs to a sandbox that has since been recycled"
 * — when the caller's current sandboxId differs from the stored one,
 * the entry is stale and we MUST recreate the context against the
 * fresh kernel. TTL mirrors `SANDBOX_REGISTRY_TTL_S` so context
 * mappings die with the sandbox they reference.
 */

const pythonContextRegistryKey = (conversationId: string): string =>
  `e2b:python-ctx:${conversationId}`;

export interface PythonContextRegistryEntry {
  contextId: string;
  sandboxId: string;
}

const isRegistryEntry = (
  value: unknown,
): value is PythonContextRegistryEntry => {
  if (typeof value !== "object" || value === null) return false;
  if (!("contextId" in value) || !("sandboxId" in value)) return false;
  const { contextId, sandboxId } = value;
  return typeof contextId === "string" && typeof sandboxId === "string";
};

export const getPythonContextFromRegistry = async (
  conversationId: string,
): Promise<PythonContextRegistryEntry | null> => {
  const raw = await redis.get(pythonContextRegistryKey(conversationId));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRegistryEntry(parsed)) {
      return { contextId: parsed.contextId, sandboxId: parsed.sandboxId };
    }
  } catch {
    // Corrupted entry — fall through to miss; next caller recreates.
  }
  return null;
};

export const setPythonContextInRegistry = async (
  conversationId: string,
  contextId: string,
  sandboxId: string,
): Promise<void> => {
  await redis.set(
    pythonContextRegistryKey(conversationId),
    JSON.stringify({ contextId, sandboxId }),
    "EX",
    SANDBOX_REGISTRY_TTL_S,
  );
};

export const clearPythonContextFromRegistry = async (
  conversationId: string,
): Promise<void> => {
  await redis.del(pythonContextRegistryKey(conversationId));
};
