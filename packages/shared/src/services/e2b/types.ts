/**
 * Shared types for the E2B sandbox layer. Kept tiny on purpose — every
 * surface beyond these primitives lives behind a function in a sibling
 * file (one operation per file, see `@fretik/shared` CLAUDE.md).
 */

export interface SandboxLease {
  sandboxId: string;
  conversationId: string;
}

export interface SandboxArtifact {
  /** Path relative to the sandbox root, e.g. `output.csv` or `subdir/chart.png`. */
  path: string;
  /** Best-effort MIME inferred from the extension; `application/octet-stream` if unknown. */
  mime: string;
  /** Byte size at the time of the post-run diff. */
  size: number;
}

export interface SandboxFileEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * One Jupyter `display_data` / `execute_result` entry surfaced by
 * `runCode` ⇒ `Execution.results[]`. Aligned with the official
 * `@e2b/code-interpreter` `Result` shape (text/html/markdown/png/...
 * representations on a single object), but flattened into a single
 * `kind` so downstream consumers (tools, UI) don't have to probe
 * every optional field.
 *
 * - `preview` — short textual representation (capped upstream so the
 *   payload that lands in the model's context stays bounded). Always
 *   set for `text` / `markdown` / `html` / `chart`; absent for binary
 *   kinds (`png` / `jpeg` / `svg` / `pdf`).
 * - `artifactPath` — workspace-relative path under
 *   `outputs/results/{toolCallId}-{idx}.{ext}` for representations
 *   that were either too large to inline (HTML over the cap) or that
 *   are inherently binary. The artifact is also surfaced in
 *   `RunResult.artifacts` so `presentFiles` can reference it.
 * - `chart` — when E2B's chart detector recognises a matplotlib /
 *   plotly figure, the structured chart metadata lands here verbatim
 *   so downstream code can transform it (e.g. into a Vega spec).
 */
export interface RichResult {
  kind:
    | "text"
    | "markdown"
    | "html"
    | "png"
    | "jpeg"
    | "svg"
    | "pdf"
    | "json"
    | "chart";
  isMainResult: boolean;
  preview?: string;
  artifactPath?: string;
  chart?: unknown;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Always 0 on success; 1 when E2B surfaces an exception. */
  exitCode: number;
  /** Last cell return value when running Python (e.g. an expression result). */
  returnValue?: unknown;
  /** Structured error from the Python kernel — name/value/traceback. */
  error?: { name: string; value: string; traceback?: string };
  /**
   * Files under the sandbox root that were created or modified during
   * this run, computed via a before/after `files.list` diff. Includes
   * any auto-captured rich-result artifacts under `outputs/results/`.
   */
  artifacts: SandboxArtifact[];
  /**
   * Files present before the run that disappeared after. Mirrors the
   * orchestrator's old `deleted_paths` so callers can keep S3 in sync.
   */
  deletedPaths: string[];
  /**
   * Jupyter display_data / execute_result captured from the kernel
   * (DataFrame HTML reprs, matplotlib plots, chart metadata). Empty
   * for `bash` runs (no kernel) and for `python` cells that produce
   * no display value.
   */
  richResults: RichResult[];
}

export interface RunOptions {
  language: "python" | "bash";
  code: string;
  /**
   * Tool call id from the AI SDK. When set, rich Jupyter results
   * (matplotlib plots, DataFrame HTML reprs) are written to
   * `outputs/results/{toolCallId}-{idx}.{ext}` so they survive past
   * the current call and can be surfaced via `presentFiles`. When
   * absent, rich results are still captured as previews but no
   * artifact files are created.
   */
  toolCallId?: string;
  /**
   * Streamed stdout chunks. Accumulated into the final `RunResult.stdout`
   * either way — the callback is purely for live-streaming to the UI.
   */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onError?: (err: { name: string; value: string; traceback?: string }) => void;
}
