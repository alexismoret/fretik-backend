import type { Context, Result } from "@e2b/code-interpreter";
import { Sandbox } from "@e2b/code-interpreter";
import { FileType } from "e2b";
import { extname } from "node:path";
import { acquireSandbox } from "./acquire-sandbox";
import { killSandbox } from "./kill-sandbox";
import {
  clearPythonContextFromRegistry,
  getPythonContextFromRegistry,
  setPythonContextInRegistry,
} from "./python-context-registry";
import type {
  RichResult,
  RunOptions,
  RunResult,
  SandboxArtifact,
} from "./types";

/**
 * Execute Python or bash inside the conversation's sandbox.
 *
 * Wraps the E2B SDK with two pieces of glue we always want:
 * 1. **Diff-based artifact tracking.** E2B doesn't surface per-run file
 *    diffs natively (no `deleted_paths`, no public `files.watch`).
 *    We snapshot `/workspace` with `files.list` before and after each
 *    run and compute (created+modified) and (deleted) sets so callers
 *    can mirror to S3 in lockstep.
 * 2. **Streaming pass-through.** `onStdout` / `onStderr` / `onError`
 *    callbacks are forwarded to the SDK's streaming hooks; the final
 *    accumulated strings come back on `RunResult.{stdout,stderr}`
 *    regardless.
 */

const WORKSPACE_ROOT = "/workspace";
const WORKSPACE_PREFIX = `${WORKSPACE_ROOT}/`;

/**
 * Recursion depth for `files.list` snapshots. The E2B API serializes
 * this to a protobuf `uint32` (max 4_294_967_295), so anything that
 * fits there is accepted server-side. We previously passed
 * `Number.MAX_SAFE_INTEGER` as a "no limit" sentinel — that overflows
 * uint32 and causes E2B to reject the request with `invalid value for
 * uint32 field depth`. The whole snapshot failed silently (caught by
 * the surrounding try/catch), `before`/`after` came back empty, the
 * before/after diff produced zero artifacts, and
 * `mirrorSandboxArtifactsToStorage` was never called. Net effect:
 * Python-generated files stayed in `/workspace` and never reached the
 * `/tmp/fretik-ai/{conv}/` hot cache, breaking `presentFiles`/`read`.
 *
 * 32 is plenty for the agent's deepest expected path (e.g.
 * `/workspace/skills/finops/templates/q1/file.xlsx` is depth 5).
 */
const WORKSPACE_LIST_DEPTH = 32;

/**
 * Get (or create) the Jupyter "code context" with `cwd: "/workspace"`
 * for this conversation. The mapping lives in Redis
 * (`python-context-registry.ts`) so multiple @fretik/ai replicas all
 * end up reusing the same kernel — without that, each instance would
 * create its own context on first hit, leaking kernels and silently
 * splitting variable state across turns.
 *
 * Cache hit semantics: only honoured if the cached entry's
 * `sandboxId` matches the live sandbox we're about to run against.
 * When `acquireSandbox` returns a fresh sandbox (E2B recycled the
 * previous one, server restart, etc.), the stored `contextId` points
 * at a dead kernel — we discard and recreate.
 *
 * State semantics: variables and imports persist across `runCode`
 * calls that share this context, identical to the daemon's default
 * Python context. **This is the public contract**: the `python` tool
 * exposes the kernel as stateful (variables/imports from prior calls
 * remain in scope), aligned with Anthropic's `code_execution` and
 * OpenAI's `code_interpreter`. To wipe the kernel without destroying
 * `/workspace`, callers use `restartPythonKernel` (kernel-only
 * restart via `sbx.restartCodeContext`); the `bash` tool's
 * `restart: true` still kills the whole sandbox for the heavy-handed
 * "filesystem corrupted, start fresh" escape hatch.
 */
const getOrCreateWorkspacePythonContext = async (
  sbx: Sandbox,
  conversationId: string,
  sandboxId: string,
): Promise<Context> => {
  const cached = await getPythonContextFromRegistry(conversationId);
  if (cached && cached.sandboxId === sandboxId) {
    // Reconstitute a `Context`-shaped object from the registry entry
    // — `runCode` only reads `context.id` so language/cwd here are
    // informational and tracked for debugging.
    return {
      id: cached.contextId,
      language: "python",
      cwd: WORKSPACE_ROOT,
    };
  }
  const created = await sbx.createCodeContext({
    language: "python",
    cwd: WORKSPACE_ROOT,
  });
  await setPythonContextInRegistry(conversationId, created.id, sandboxId);
  return created;
};

/**
 * E2B's `files.list("/workspace")` returns absolute paths
 * (`/workspace/foo.docx`). Strip the prefix so artifact paths are
 * relative basenames — that's the contract every downstream consumer
 * expects (mirror to S3, presentFiles, read tool, agent prompt). Paths
 * outside `/workspace/` (rare; shouldn't happen with our list root) are
 * returned as-is so the caller can spot them.
 */
const toRelWorkspacePath = (absPath: string): string =>
  absPath.startsWith(WORKSPACE_PREFIX)
    ? absPath.slice(WORKSPACE_PREFIX.length)
    : absPath;

const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".html": "text/html",
};

const inferMime = (path: string): string =>
  MIME_BY_EXT[extname(path).toLowerCase()] ?? "application/octet-stream";

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

const snapshotWorkspace = async (
  sbx: Sandbox,
): Promise<Map<string, FileSnapshot>> => {
  const result = new Map<string, FileSnapshot>();
  try {
    const entries = await sbx.files.list(WORKSPACE_ROOT, {
      depth: WORKSPACE_LIST_DEPTH,
    });
    for (const entry of entries) {
      if (entry.type !== FileType.FILE) continue;
      result.set(toRelWorkspacePath(entry.path), {
        size: typeof entry.size === "number" ? entry.size : 0,
        // The E2B SDK exposes the modification time as `modifiedTime:
        // Date | undefined`, NOT `mtimeMs`. Reading the wrong field
        // pinned every snapshot's mtime to 0, which made the
        // before/after diff blind to modified-but-same-size writes
        // (Python overwriting a synced-in file with identical bytes).
        mtimeMs:
          entry.modifiedTime instanceof Date ? entry.modifiedTime.getTime() : 0,
      });
    }
  } catch (err) {
    console.warn(
      "[e2b:run] workspace snapshot failed:",
      err instanceof Error ? err.message : err,
    );
  }
  return result;
};

interface ExecLogs {
  stdout?: string | string[];
  stderr?: string | string[];
}

const flatten = (value: string | string[] | undefined): string => {
  if (!value) return "";
  return Array.isArray(value) ? value.join("") : value;
};

/**
 * Per-rich-result preview cap — keeps the model's context bounded
 * even when a cell emits a large DataFrame `_repr_html_()`. Values
 * over the cap are truncated inline; the full payload is also
 * written to disk under `outputs/results/` (when `toolCallId` is
 * supplied) and exposed via `RichResult.artifactPath` so the model
 * can recover the rest with `read(...)` if it needs to.
 */
const RICH_RESULT_PREVIEW_CHARS = 4_000;
const RICH_RESULTS_DIR = "outputs/results";

const decodeBase64 = (data: string): Uint8Array => {
  // E2B's `Result.png` / `Result.jpeg` / `Result.pdf` are base64
  // strings; SVG is raw text. `atob` is a globally available Bun
  // built-in.
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const truncatePreview = (value: string): string =>
  value.length <= RICH_RESULT_PREVIEW_CHARS
    ? value
    : `${value.slice(0, RICH_RESULT_PREVIEW_CHARS)}…`;

/**
 * Coerce an E2B `Result.json` / `Result.text` field to a string the
 * frontend can render. E2B types both as `string | undefined`, but the
 * Jupyter `application/json` mimetype is sometimes forwarded as the
 * already-parsed value (array / object) — Vue's `{{ value }}` then
 * coerces to `[object Object],[object Object]…`. We pretty-print to a
 * 2-space indented JSON so the rendering matches what Claude / ChatGPT
 * surface for a bare-expression dict or list.
 */
const richPayloadToString = (value: unknown): string => {
  if (typeof value === "string") {
    // Already a JSON string from E2B: re-pretty-print if it's a single
    // long line of compact JSON so the chat UI doesn't show one wide row.
    if (
      value.length > 120 &&
      !value.includes("\n") &&
      (value.startsWith("{") || value.startsWith("["))
    ) {
      try {
        return JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        // Not actually JSON — return as-is.
      }
    }
    return value;
  }
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable value]";
  }
};

interface CapturedRichResult {
  rich: RichResult;
  /** Absolute sandbox path to write before the post-run snapshot, if any. */
  artifactWrite?: { absPath: string; bytes: Uint8Array };
}

/**
 * Convert one E2B `Result` (one Jupyter display_data / execute_result)
 * into one or more `RichResult` entries. We pick the highest-fidelity
 * representation available in this priority order:
 *   binary (png > jpeg > svg > pdf) → html → markdown → chart → json → text
 * Binary kinds are written to `outputs/results/{toolCallId}-{idx}.{ext}`
 * and surfaced as artifacts; text-like kinds are inlined as previews
 * (capped at `RICH_RESULT_PREVIEW_CHARS`). When `toolCallId` is unset
 * (rare — internal callers without a tool ctx), binary kinds are
 * dropped silently to avoid filename collisions.
 */
const captureRichResult = (
  result: Result,
  toolCallId: string | undefined,
  index: number,
): CapturedRichResult | null => {
  const baseName = toolCallId
    ? `${toolCallId}-${String(index)}`
    : `anon-${String(index)}`;
  const buildPath = (ext: string): string =>
    `${RICH_RESULTS_DIR}/${baseName}.${ext}`;
  const buildAbs = (ext: string): string =>
    `${WORKSPACE_ROOT}/${buildPath(ext)}`;

  if (result.png && toolCallId) {
    return {
      rich: {
        kind: "png",
        isMainResult: result.isMainResult,
        artifactPath: buildPath("png"),
      },
      artifactWrite: {
        absPath: buildAbs("png"),
        bytes: decodeBase64(result.png),
      },
    };
  }
  if (result.jpeg && toolCallId) {
    return {
      rich: {
        kind: "jpeg",
        isMainResult: result.isMainResult,
        artifactPath: buildPath("jpg"),
      },
      artifactWrite: {
        absPath: buildAbs("jpg"),
        bytes: decodeBase64(result.jpeg),
      },
    };
  }
  if (result.svg && toolCallId) {
    return {
      rich: {
        kind: "svg",
        isMainResult: result.isMainResult,
        artifactPath: buildPath("svg"),
      },
      artifactWrite: {
        absPath: buildAbs("svg"),
        bytes: new TextEncoder().encode(result.svg),
      },
    };
  }
  if (result.pdf && toolCallId) {
    return {
      rich: {
        kind: "pdf",
        isMainResult: result.isMainResult,
        artifactPath: buildPath("pdf"),
      },
      artifactWrite: {
        absPath: buildAbs("pdf"),
        bytes: decodeBase64(result.pdf),
      },
    };
  }
  if (result.html) {
    const htmlStr = richPayloadToString(result.html);
    const oversize =
      htmlStr.length > RICH_RESULT_PREVIEW_CHARS && Boolean(toolCallId);
    const rich: RichResult = {
      kind: "html",
      isMainResult: result.isMainResult,
      preview: truncatePreview(htmlStr),
      ...(oversize ? { artifactPath: buildPath("html") } : {}),
    };
    if (oversize) {
      return {
        rich,
        artifactWrite: {
          absPath: buildAbs("html"),
          bytes: new TextEncoder().encode(htmlStr),
        },
      };
    }
    return { rich };
  }
  if (result.markdown) {
    return {
      rich: {
        kind: "markdown",
        isMainResult: result.isMainResult,
        preview: truncatePreview(richPayloadToString(result.markdown)),
      },
    };
  }
  if (result.chart !== undefined) {
    return {
      rich: {
        kind: "chart",
        isMainResult: result.isMainResult,
        chart: result.chart,
        ...(result.text
          ? { preview: truncatePreview(richPayloadToString(result.text)) }
          : {}),
      },
    };
  }
  if (result.json) {
    return {
      rich: {
        kind: "json",
        isMainResult: result.isMainResult,
        preview: truncatePreview(richPayloadToString(result.json)),
      },
    };
  }
  if (result.text) {
    return {
      rich: {
        kind: "text",
        isMainResult: result.isMainResult,
        preview: truncatePreview(richPayloadToString(result.text)),
      },
    };
  }
  return null;
};

export interface RunInSandboxOptions extends RunOptions {
  /**
   * If true, kill and recreate the sandbox before running. Reserved for
   * the `bash` tool's `restart` escape hatch — wipes `/workspace` and
   * any in-flight processes. The `python` tool uses
   * `restartPythonKernel` instead, which preserves `/workspace` and
   * only resets the Jupyter kernel.
   */
  restart?: boolean;
  /**
   * The turn's server-owned abort signal (a user Stop, see the chatbot
   * handler's abort channel). E2B's `runCode` / `commands.run` expose no
   * AbortSignal, so the only in-band cancellation lever is to KILL the
   * sandbox — `runInSandbox` races the exec against this signal and, on
   * abort, kills the sandbox (dropping the running cell/command
   * immediately) and returns an `Aborted` result. The sandbox is
   * recreated lazily on the next turn. Without this, a Stop during a
   * long python/bash run does nothing until the run finishes on its own.
   */
  abortSignal?: AbortSignal;
}

/**
 * Sentinel returned by `raceSandboxAbort` when the turn was Stopped
 * while an exec was in flight.
 */
const ABORTED_SENTINEL = Symbol("e2b-aborted");

/** Synthetic `RunResult` for a user-aborted run (no artifacts, no diff). */
const abortedRunResult = (): RunResult => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  error: { name: "Aborted", value: "Stopped by user" },
  artifacts: [],
  deletedPaths: [],
  richResults: [],
});

/**
 * Race an in-flight sandbox exec against the turn's abort signal. When
 * the user Stops mid-run, E2B can't cancel the exec in-band, so we kill
 * the whole sandbox — that terminates the running cell/command at once —
 * and resolve to {@link ABORTED_SENTINEL}. The orphaned exec promise is
 * swallowed (it rejects once the sandbox dies). When no signal is
 * provided, or it never fires, the exec resolves normally.
 */
const raceSandboxAbort = async <T>(
  conversationId: string,
  signal: AbortSignal | undefined,
  exec: Promise<T>,
): Promise<T | typeof ABORTED_SENTINEL> => {
  if (!signal) return exec;
  if (signal.aborted) {
    void killSandbox(conversationId).catch(() => undefined);
    void exec.catch(() => undefined);
    return ABORTED_SENTINEL;
  }
  return await new Promise<T | typeof ABORTED_SENTINEL>((resolve, reject) => {
    const onAbort = (): void => {
      void killSandbox(conversationId).catch(() => undefined);
      void exec.catch(() => undefined);
      resolve(ABORTED_SENTINEL);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    exec.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
};

export const runInSandbox = async (
  conversationId: string,
  options: RunInSandboxOptions,
): Promise<RunResult> => {
  // Cooperative cancel: the turn was already Stopped — don't even spin
  // up / connect the sandbox.
  if (options.abortSignal?.aborted) return abortedRunResult();

  if (options.restart) {
    // Cached context belongs to the kernel we're about to kill —
    // wipe it before tearing the sandbox down so the next run picks
    // a fresh contextId rather than dialing a dead one.
    await clearPythonContextFromRegistry(conversationId);
    await killSandbox(conversationId);
  }
  const lease = await acquireSandbox(conversationId);
  const sbx = await Sandbox.connect(lease.sandboxId);

  const before = await snapshotWorkspace(sbx);

  let stdoutBuf = "";
  let stderrBuf = "";
  let kernelError: RunResult["error"] | undefined;
  const richResults: RichResult[] = [];

  if (options.language === "python") {
    const context = await getOrCreateWorkspacePythonContext(
      sbx,
      conversationId,
      lease.sandboxId,
    );
    const exec = await raceSandboxAbort(
      conversationId,
      options.abortSignal,
      sbx.runCode(options.code, {
        context,
        onStdout: (data: { line?: string }) => {
          const line = data.line ?? "";
          stdoutBuf += line;
          options.onStdout?.(line);
        },
        onStderr: (data: { line?: string }) => {
          const line = data.line ?? "";
          stderrBuf += line;
          options.onStderr?.(line);
        },
        onError: (err: { name: string; value: string; traceback?: string }) => {
          kernelError = err;
          options.onError?.(err);
        },
      }),
    );
    if (exec === ABORTED_SENTINEL) return abortedRunResult();

    // The SDK also exposes accumulated logs on `exec.logs`; prefer the
    // streamed buffers (already populated above) and fall back to the
    // SDK accumulator if streaming returned nothing.
    if (!stdoutBuf) stdoutBuf = flatten((exec.logs as ExecLogs).stdout);
    if (!stderrBuf) stderrBuf = flatten((exec.logs as ExecLogs).stderr);
    if (!kernelError && exec.error) {
      kernelError = {
        name: exec.error.name,
        value: exec.error.value,
        traceback: exec.error.traceback,
      };
    }

    // Capture Jupyter display_data / execute_result entries. Binary
    // representations (PNG / JPEG / SVG / PDF) and oversize HTML are
    // written under `outputs/results/` BEFORE the post-run snapshot so
    // they naturally appear in `artifacts` and get S3-mirrored by the
    // tool layer's `mirrorSandboxChanges`. Sequential await on each
    // write is intentional — E2B's filesystem isn't a bottleneck and
    // the loop is bounded by the cell's display_data count (typically
    // 0–3 entries per cell).
    /* oxlint-disable no-await-in-loop -- bounded by exec.results.length and per-write E2B file IO */
    for (let i = 0; i < exec.results.length; i++) {
      const result = exec.results[i];
      if (!result) continue;
      const captured = captureRichResult(result, options.toolCallId, i);
      if (!captured) continue;
      if (captured.artifactWrite) {
        try {
          // The E2B SDK's `files.write` accepts string | ArrayBuffer |
          // Blob | ReadableStream. `Uint8Array` is a *view* over an
          // ArrayBuffer, not the buffer itself, so we wrap it in a
          // Blob — Blob is a clean, no-cast value type the SDK accepts
          // without forcing us to break the no-unsafe-type-assertion
          // rule with an `as ArrayBuffer` cast.
          await sbx.files.write(
            captured.artifactWrite.absPath,
            new Blob([captured.artifactWrite.bytes]),
          );
        } catch (err) {
          console.warn(
            `[e2b:run] failed to write rich result ${captured.artifactWrite.absPath}:`,
            err instanceof Error ? err.message : err,
          );
          // Drop the artifactPath ref so the model isn't told a file
          // exists when the write failed.
          delete captured.rich.artifactPath;
        }
      }
      richResults.push(captured.rich);
    }
    /* oxlint-enable no-await-in-loop */
  } else {
    // The template's `setWorkdir("/workspace")` already makes
    // `commands.run` default to /workspace, but we pin it here as
    // defense-in-depth — a future template change wouldn't silently
    // regress the cwd contract.
    const result = await raceSandboxAbort(
      conversationId,
      options.abortSignal,
      sbx.commands.run(options.code, {
        cwd: WORKSPACE_ROOT,
        onStdout: (chunk: string) => {
          stdoutBuf += chunk;
          options.onStdout?.(chunk);
        },
        onStderr: (chunk: string) => {
          stderrBuf += chunk;
          options.onStderr?.(chunk);
        },
      }),
    );
    if (result === ABORTED_SENTINEL) return abortedRunResult();
    if (result.exitCode !== 0) {
      kernelError = {
        name: "NonZeroExit",
        value: `exit code ${result.exitCode}`,
      };
    }
  }

  const after = await snapshotWorkspace(sbx);

  const artifacts: SandboxArtifact[] = [];
  for (const [path, snap] of after.entries()) {
    const prev = before.get(path);
    if (!prev || prev.mtimeMs !== snap.mtimeMs || prev.size !== snap.size) {
      artifacts.push({ path, mime: inferMime(path), size: snap.size });
    }
  }
  const deletedPaths: string[] = [];
  for (const path of before.keys()) {
    if (!after.has(path)) deletedPaths.push(path);
  }

  return {
    stdout: stdoutBuf,
    stderr: stderrBuf,
    exitCode: kernelError ? 1 : 0,
    error: kernelError,
    artifacts,
    deletedPaths,
    richResults,
  };
};
