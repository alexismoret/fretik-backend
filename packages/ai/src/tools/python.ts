import { restartPythonKernel } from "@fretik/shared/services/e2b/restart-python-kernel";
import { runInSandbox } from "@fretik/shared/services/e2b/run-in-sandbox";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  mirrorSandboxChanges,
  prepareSandbox,
} from "../lib/conversation-storage";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { mapE2BError } from "./_e2b-errors";

/**
 * Aligned with Anthropic's `code_execution_20260120` and OpenAI's
 * `code_interpreter`:
 *  - input fields: `code` (mandatory), `restart` (optional)
 *  - output on success: `{ stdout, stderr, artifacts, richResults }`
 *  - output on failure: `{ error, code, stdout?, stderr? }`
 *
 * Each call runs against the conversation's persistent Jupyter kernel
 * inside the conversation's E2B sandbox. The Redis-backed code
 * context (`python-context-registry.ts`) ensures every replica of
 * @fretik/ai talks to the same kernel for a given `conversationId`,
 * so variables, imports, and function definitions defined in earlier
 * `python` calls remain in scope across the whole conversation.
 *
 * State semantics — public contract surfaced to the model:
 *  - The Python kernel is **stateful** within a conversation. Variables
 *    and imports persist across calls. Re-importing or re-loading a
 *    DataFrame on every call is wasteful and is no longer recommended.
 *  - The filesystem under `/workspace` is also stateful (and shared
 *    with `bash`).
 *  - Set `restart: true` to wipe the kernel before running the code:
 *    all Python state is dropped (`restartCodeContext` on the daemon),
 *    `/workspace` is preserved.
 *
 * `prepareSandbox` ensures the workspace layout is initialised
 * (skill bundles pushed, `attachments/` / `outputs/` restored from S3
 * on cold start) before the code runs. After execution,
 * `mirrorSandboxChanges` copies any created/modified files under
 * `attachments/` or `outputs/` to S3 — including the rich-result
 * artifacts auto-captured under `outputs/results/`.
 */

const inputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      "Python source to execute in the conversation's persistent Jupyter kernel. Variables, imports, and function definitions from previous `python` calls in this conversation are still in scope — reuse them instead of re-importing every call. Files under `/workspace` persist across calls (shared with `bash`). Available helpers: `from skill_loader import load_skill, list_skills` (loads a bundled skill's scripts/ onto sys.path).",
    ),
  restart: z
    .boolean()
    .optional()
    .describe(
      "If true, restart the Python kernel BEFORE running this code: all variables, imports, and in-memory state are dropped. Files under `/workspace` are preserved (use the `bash` tool's `restart` for the heavier sandbox-wide reset). Use this when state has become incoherent — e.g. a runaway monkey-patch, a corrupted import, or to free a large object from memory.",
    ),
});

export const createPythonTool = () =>
  tool({
    description: [
      "Executes Python 3 in the conversation's persistent Jupyter kernel (E2B sandbox).",
      "",
      "Reach for `python` whenever the work involves structured or tabular data — parse the source programmatically rather than transcribing rows from a previous tool result. If you are about to embed values you just read into Python list/tuple literals, stop and open the source file directly: load the file with the right library (`pdfplumber`, `pandas`, `openpyxl`, `json`, …) and bind it to a variable. Transcribed literals drift from the source as soon as anything is reformatted, and silently mis-match downstream.",
      "",
      "**Stateful kernel.** Variables, imports, and function definitions you create in one `python` call are still available in the next `python` call in this conversation. Re-importing pandas / re-reading a CSV every call is wasteful — load once into a named variable, reuse it. If a variable from earlier in this conversation is missing (NameError), the kernel was restarted; reload from `outputs/` files.",
      "",
      "Filesystem layout under `/workspace` (persists across calls, shared with `bash`):",
      "  - `attachments/` — user uploads in this conversation",
      "  - `outputs/` — files you create here are surfaced to the user via `presentFiles`",
      "  - `outputs/results/` — auto-captured rich Jupyter outputs (DataFrame HTML, matplotlib plots) keyed by toolCallId; readable like any other workspace file",
      "  - `drive/` — Drive documents downloaded with `download_drive_document`",
      "  - `skills/` — bundled skill bundles (read-only). Use `from skill_loader import load_skill; load_skill('<name>')` then import the script you need.",
      "  - `context/` — team/user persistent context",
      "",
      "Files you create or modify under `attachments/` or `outputs/` are auto-mirrored to durable S3 storage so a sandbox recreated after expiry sees them again.",
      "",
      "Restart semantics: pass `restart: true` to wipe the kernel (variables, imports) before running this code; the filesystem is preserved. The `bash` tool has its own heavier `restart` that nukes the whole sandbox including `/workspace` — use that only for filesystem corruption.",
      "",
      "Sandbox: 1 vCPU, 1 GB memory, 5 min wall-clock timeout, non-root user, /workspace as cwd. Outbound internet is restricted to a curated allowlist (PyPI, GitHub, Fretik, common carrier APIs) — `pip install` works for those. Note: a `pip install` from `bash` is invisible to a kernel that already imported the package; restart the Python kernel (`restart: true`) to pick it up.",
      "",
      "Pre-installed libraries:",
      "- Data: pandas, numpy, pyarrow",
      "- Spreadsheets: openpyxl, xlrd, xlsxwriter",
      "- Office documents: python-docx, python-pptx",
      "- PDF read: pypdf, pdfplumber",
      "- PDF write: reportlab",
      "- Plotting / images: matplotlib, pillow",
      "- Scientific: scipy, scikit-learn, statsmodels",
      "- String matching: rapidfuzz (use `rapidfuzz.fuzz.ratio` or `rapidfuzz.process.extract` when joining records across files with formatting differences — accents, punctuation, abbreviations, suffix variation; the `tabular-extraction` skill has a worked protocol)",
      "",
      "Output: `{ stdout, stderr, artifacts: [{path, mime, size}], richResults: [{kind, isMainResult, preview?, artifactPath?, chart?}] }`. `richResults` captures Jupyter display_data (DataFrame HTML reprs land as `kind: 'html'` with a preview; matplotlib plots land as `kind: 'png'` with `artifactPath` pointing at `outputs/results/...`). Don't `print(df.head())` after a cell that already returned the HTML — read it from the previous `richResults`. Large outputs (>32K serialized) are swapped for a `<persisted-output>` envelope.",
      "",
      "Examples:",
      "- Load once, reuse: call 1 → `import pandas as pd; df = pd.read_excel('attachments/data.xlsx'); df.head()` (HTML preview comes back in `richResults`); call 2 → `df.shape`; call 3 → `df.groupby('category').size()`. No re-import, no re-read.",
      "- Save a chart: `import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.savefig('outputs/chart.png')` — call `presentFiles(['outputs/chart.png'])` afterwards. Or just `plt.show()` and the PNG lands automatically in `outputs/results/`.",
      "- Use a bundled skill (load once at conversation start): `from skill_loader import load_skill; load_skill('pdf'); from extract_form import fill_form` — `fill_form` stays importable in subsequent calls.",
    ].join("\n"),
    inputSchema,
    execute: async ({ code, restart }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      if (!ctx.conversationId) {
        return {
          error:
            "python requires an active conversation context. No conversationId was provided.",
          code: "NO_CONVERSATION",
        };
      }
      const conversationId = ctx.conversationId;

      try {
        await prepareSandbox(conversationId);
      } catch (err) {
        return mapE2BError(err, "while preparing sandbox workspace");
      }

      if (restart) {
        try {
          await restartPythonKernel(conversationId);
        } catch (err) {
          return mapE2BError(err, "while restarting Python kernel");
        }
      }

      let result;
      try {
        result = await runInSandbox(conversationId, {
          language: "python",
          code,
          toolCallId,
        });
      } catch (err) {
        return mapE2BError(err, "while running Python in sandbox");
      }

      if (result.artifacts.length > 0 || result.deletedPaths.length > 0) {
        await mirrorSandboxChanges(
          conversationId,
          result.artifacts,
          result.deletedPaths,
        );
      }

      if (result.error) {
        return {
          error: `${result.error.name}: ${result.error.value}`,
          code: "PYTHON_ERROR",
          stdout: result.stdout,
          stderr: result.error.traceback ?? result.stderr,
        };
      }

      const payload = {
        stdout: result.stdout,
        stderr: result.stderr,
        artifacts: result.artifacts,
        richResults: result.richResults,
      };

      return maybePersistLargeOutput(payload, conversationId, toolCallId);
    },
  });
