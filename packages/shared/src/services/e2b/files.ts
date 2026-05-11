import { Sandbox } from "@e2b/code-interpreter";
import { FileType } from "e2b";
import { acquireSandbox } from "./acquire-sandbox";
import type { SandboxFileEntry } from "./types";

/**
 * Sandbox filesystem helpers. Every operation acquires the conversation's
 * sandbox (resume if paused, create if missing) before delegating to the
 * SDK. The conversation's `/workspace` is the working tree — paths are
 * either basenames (treated as `/workspace/<name>`) or absolute paths.
 *
 * Kept colocated in one file because they all share the same path-
 * normalisation rules and there's no behaviour worth splitting per-
 * operation here. The "one file per operation" convention covers
 * services that have non-trivial logic per op; here every function is
 * a 1:1 SDK pass-through.
 */

const SANDBOX_WORKSPACE = "/workspace";
const WORKSPACE_PREFIX = `${SANDBOX_WORKSPACE}/`;

/**
 * `files.list` `depth` is serialized as a protobuf `uint32`. Passing a
 * value above 2^32 (e.g. `Number.MAX_SAFE_INTEGER`) is rejected by the
 * E2B server with `invalid value for uint32 field depth`. 32 levels
 * cover any path the agent realistically produces.
 */
const SANDBOX_LIST_DEPTH = 32;

const toAbsolutePath = (path: string): string => {
  if (path.startsWith("/")) return path;
  return `${SANDBOX_WORKSPACE}/${path}`;
};

/**
 * E2B's `files.list` returns absolute paths (`/workspace/foo.csv`);
 * strip the prefix so consumers see relative basenames consistent with
 * `runInSandbox`'s artifact list.
 */
const toRelWorkspacePath = (absPath: string): string =>
  absPath.startsWith(WORKSPACE_PREFIX)
    ? absPath.slice(WORKSPACE_PREFIX.length)
    : absPath;

export const writeSandboxFile = async (
  conversationId: string,
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  // SDK accepts `string | ArrayBuffer | Blob | ReadableStream`. Wrap
  // the view in a Blob so we hand the SDK a stable byte container
  // regardless of the underlying buffer layout.
  await sbx.files.write(toAbsolutePath(path), new Blob([bytes]));
};

export const readSandboxFile = async (
  conversationId: string,
  path: string,
): Promise<Uint8Array> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  const content = await sbx.files.read(toAbsolutePath(path), {
    format: "bytes",
  });
  return content;
};

export const listSandboxFiles = async (
  conversationId: string,
  prefix?: string,
): Promise<SandboxFileEntry[]> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  const root = prefix ? toAbsolutePath(prefix) : SANDBOX_WORKSPACE;
  const entries = await sbx.files.list(root, {
    depth: SANDBOX_LIST_DEPTH,
  });
  return entries
    .filter((e) => e.type === FileType.FILE)
    .map((e) => ({
      path: toRelWorkspacePath(e.path),
      size: e.size,
      mtimeMs: e.modifiedTime ? e.modifiedTime.getTime() : 0,
    }));
};

export const removeSandboxFile = async (
  conversationId: string,
  path: string,
): Promise<void> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  await sbx.files.remove(toAbsolutePath(path));
};

/**
 * Recursive idempotent directory creation (mkdir -p semantics). E2B
 * does not error when the target already exists, but we still wrap
 * in try/catch and ignore "exists" failures because cross-replica
 * bootstrap runs may race.
 */
export const makeSandboxDir = async (
  conversationId: string,
  path: string,
): Promise<void> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  try {
    await sbx.files.makeDir(toAbsolutePath(path));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/exists/i.test(message)) {
      throw err;
    }
  }
};

/**
 * Cheap "does this file exist?" probe. Returns `true` when the SDK
 * can read a single byte at `path`, `false` on any error (missing,
 * permission, transient). Callers typically use this before deciding
 * whether to skip a redundant write.
 */
export const sandboxFileExists = async (
  conversationId: string,
  path: string,
): Promise<boolean> => {
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);
  try {
    await sbx.files.read(toAbsolutePath(path), { format: "bytes" });
    return true;
  } catch {
    return false;
  }
};
