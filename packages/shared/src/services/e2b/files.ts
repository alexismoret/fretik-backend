import type { CommandResult } from "e2b";
import { CommandExitError, FileType } from "e2b";
import { acquireSandbox } from "./acquire-sandbox";
import { SANDBOX_TIMEOUT_MS } from "./client";
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
  const { sandbox: sbx } = await acquireSandbox(conversationId);
  // SDK accepts `string | ArrayBuffer | Blob | ReadableStream`. Wrap
  // the view in a Blob so we hand the SDK a stable byte container
  // regardless of the underlying buffer layout.
  await sbx.files.write(toAbsolutePath(path), new Blob([bytes]));
};

/**
 * Write several files in ONE request (`files.write`'s multi-entry overload).
 *
 * All-or-nothing by design: the SDK sends a single multipart request, so a
 * rejection means nothing landed. Callers that need per-file resilience keep
 * a `writeSandboxFile` fallback — this is the fast path, not a replacement.
 * Use it whenever the file set is known up front; the per-file loop it
 * replaces cost one round-trip each.
 */
export const writeSandboxFiles = async (
  conversationId: string,
  files: readonly { path: string; bytes: Uint8Array }[],
): Promise<void> => {
  if (files.length === 0) return;
  const { sandbox: sbx } = await acquireSandbox(conversationId);
  await sbx.files.write(
    files.map((f) => ({
      path: toAbsolutePath(f.path),
      // Same reason as `writeSandboxFile`: a Blob is a no-cast byte container.
      data: new Blob([f.bytes]),
    })),
  );
};

export const readSandboxFile = async (
  conversationId: string,
  path: string,
): Promise<Uint8Array> => {
  const { sandbox: sbx } = await acquireSandbox(conversationId);
  const content = await sbx.files.read(toAbsolutePath(path), {
    format: "bytes",
  });
  return content;
};

export const listSandboxFiles = async (
  conversationId: string,
  prefix?: string,
): Promise<SandboxFileEntry[]> => {
  const { sandbox: sbx } = await acquireSandbox(conversationId);
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
  const { sandbox: sbx } = await acquireSandbox(conversationId);
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
  const { sandbox: sbx } = await acquireSandbox(conversationId);
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
 * "Does this file exist?" probe, `false` on any error (missing, permission,
 * transient). Callers use it before deciding whether to skip a redundant
 * write.
 *
 * Uses `files.exists`, a metadata call. It used to `files.read(…, "bytes")`
 * — i.e. DOWNLOAD THE WHOLE FILE to answer a boolean — on a path that runs
 * per restored S3 file, per context file per turn, per presented file, and
 * every 200 ms while polling for the bootstrap marker.
 */
export const sandboxFileExists = async (
  conversationId: string,
  path: string,
): Promise<boolean> => {
  const { sandbox: sbx } = await acquireSandbox(conversationId);
  try {
    return await sbx.files.exists(toAbsolutePath(path));
  } catch {
    return false;
  }
};

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a one-shot shell command in the conversation's sandbox.
 *
 * Thin wrapper over `sbx.commands.run` — kept here so callers that just
 * need a synchronous bash exec (e.g. `tar -xzf` during bootstrap, a
 * one-line filesystem fixup) don't have to pull in the much heavier
 * `runInSandbox` (which manages the persistent Jupyter kernel, captures
 * rich outputs, snapshots /workspace before/after, and mirrors changes
 * to S3 — all overkill for "run this command, give me the exit code").
 *
 * `cwd` defaults to `/workspace` to match the template's `setWorkdir`
 * contract.
 *
 * A non-zero exit is a RESULT, not a failure: `commands.run` throws
 * `CommandExitError` for it, and that error implements `CommandResult`, so we
 * unwrap it back into the shape callers expect. Letting it propagate lost
 * stdout/stderr and turned "the tarball failed to extract" into an opaque
 * sandbox error.
 */
export const execSandboxCommand = async (
  conversationId: string,
  command: string,
  options: { cwd?: string } = {},
): Promise<SandboxCommandResult> => {
  const { sandbox: sbx } = await acquireSandbox(conversationId);
  let result: CommandResult;
  try {
    result = await sbx.commands.run(command, {
      cwd: options.cwd ?? SANDBOX_WORKSPACE,
      // The SDK default is 60 s. Callers here extract multi-MB tarballs
      // (bundled skills, the memory tree), which can outrun it.
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof CommandExitError)) throw err;
    result = err;
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
