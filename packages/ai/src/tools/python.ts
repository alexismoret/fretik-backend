import { restartPythonKernel } from "@fretik/shared/services/e2b/restart-python-kernel";
import { runInSandbox } from "@fretik/shared/services/e2b/run-in-sandbox";
import { consumeSandboxApprovalPending } from "@fretik/shared/services/external-apps/approvals/sandbox-signal";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { prepareSandboxForCode } from "../lib/context-files-hydration";
import { mirrorSandboxChanges } from "../lib/conversation-storage";
import { E2B_PRICE_PER_SECOND } from "../lib/e2b-cost";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { withSlot } from "../lib/rate-limit";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";
import { traceExternalCall } from "../lib/trace-tool";
import { mapE2BError } from "./_e2b-errors";

/**
 * Per-conversation E2B execution mutex.
 *
 * The E2B sandbox is keyed on `conversationId` (Redis
 * `e2b:sandbox:{conversationId}`) and is therefore SHARED between
 * the parent agent and every sub-agent it spawns via `dispatchAgent`.
 * The Jupyter kernel inside that sandbox is NOT thread-safe, and the
 * sandbox itself only has 1 vCPU / 1 GB. When several sub-agents
 * (or parent + sub-agent) issue concurrent `python` / `bash` calls
 * on the same conversation, the kernel serialises them under load
 * and we have observed timeouts on `workspace snapshot` and
 * `restartCodeContext` plus general contention.
 *
 * Solution: serialise EVERY sandbox-touching call (`runInSandbox`,
 * `restartPythonKernel`) per `conversationId` with a Redis-backed
 * mutex (`withSlot` capacity 1). Parallel sub-agents that only touch
 * `searchKnowledge`, `querySql`, `read`, `searchWeb` are NOT
 * affected — they don't go through this mutex.
 *
 * Hold timeout: 5 min wall-clock cap per E2B call (cf. CLAUDE.md
 * `<sandbox_constraints>`) + 30 s grace for snapshot / mirror
 * overhead. If a replica crashes mid-call, the slot self-reclaims
 * after this timeout so the next caller is not stuck forever.
 */
const E2B_EXEC_HOLD_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
const e2bExecMutexKey = (conversationId: string): string =>
  `e2b:exec:${conversationId}`;

/**
 * Wraps a `restartPythonKernel` failure so the outer catch attributes it to
 * the kernel restart ("while restarting the Python kernel") rather than the
 * code run that never executed. `cause` carries the original error so
 * `mapE2BError` can still detect E2B-typed failures.
 */
class KernelRestartError extends Error {
  constructor(cause: unknown) {
    super("Python kernel restart failed", { cause });
  }
}

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
      "Sandbox: 1 vCPU, 1 GB memory, 5 min wall-clock timeout, non-root user, /workspace as cwd. Outbound internet is restricted to a curated allowlist (PyPI, GitHub, Fretik, common B2B service APIs) — `pip install` works for those. Note: a `pip install` from `bash` is invisible to a kernel that already imported the package; restart the Python kernel (`restart: true`) to pick it up.",
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
      const { toolCallId, abortSignal } = options;
      if (!ctx.conversationId) {
        return {
          error:
            "python requires an active conversation context. No conversationId was provided.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      // User already Stopped before this call started — bail cleanly.
      if (abortSignal?.aborted) {
        return { error: "Stopped.", code: TOOL_ERROR_CODES.ABORTED };
      }

      try {
        await prepareSandboxForCode({
          conversationId,
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          userId: ctx.userId,
          traceId: ctx.traceId,
        });
      } catch (err) {
        return mapE2BError(err, "while preparing sandbox workspace");
      }

      // Serialise restart + run on the per-conversation E2B sandbox.
      // Parent + sub-agents share the same sandbox; the Jupyter
      // kernel can't handle concurrent execution. See the
      // `E2B_EXEC_HOLD_TIMEOUT_MS` docblock at the top of this
      // file for the full rationale.
      let result;
      try {
        result = await withSlot(
          e2bExecMutexKey(conversationId),
          1,
          E2B_EXEC_HOLD_TIMEOUT_MS,
          async () => {
            if (restart) {
              try {
                await restartPythonKernel(conversationId);
              } catch (err) {
                // Tag so the outer mapper attributes the failure to the
                // kernel restart, not the (never-reached) code run.
                throw new KernelRestartError(err);
              }
            }
            return traceExternalCall(
              "e2b-python",
              { code, restart },
              () =>
                runInSandbox(conversationId, {
                  language: "python",
                  code,
                  toolCallId,
                  abortSignal,
                }),
              (r, durationMs) => ({
                output: {
                  error: r.error ? `${r.error.name}: ${r.error.value}` : null,
                },
                costUsd: (durationMs / 1000) * E2B_PRICE_PER_SECOND,
                metadata: { durationMs },
              }),
            );
          },
        );
      } catch (err) {
        if (err instanceof KernelRestartError) {
          return mapE2BError(err.cause, "while restarting the Python kernel");
        }
        return mapE2BError(err, "while running Python in sandbox");
      }

      // Stopped mid-run: the sandbox was killed by the abort race. Skip the
      // S3 mirror (the workspace is gone) and return a clean marker.
      if (abortSignal?.aborted) {
        return { error: "Stopped.", code: TOOL_ERROR_CODES.ABORTED };
      }

      if (result.artifacts.length > 0 || result.deletedPaths.length > 0) {
        await mirrorSandboxChanges(
          conversationId,
          result.artifacts,
          result.deletedPaths,
        );
      }

      // Did `run_plan(...)` create a pending approval during this cell? The
      // dispatcher stamps an out-of-band signal whenever it returns
      // `approval_pending`. We consume it (read-once) regardless of how the
      // cell ended so a swallowed `ApprovalPending` (agent wrapped run_plan
      // in try/except, or just printed the ops) still surfaces the approval
      // card and pauses the turn. See `approvals/sandbox-signal.ts`.
      const dispatchedApprovalId =
        await consumeSandboxApprovalPending(conversationId);

      if (result.error) {
        // `fretik_apps.run_plan(...)` raises `ApprovalPending(approval_id)`
        // whenever a write plan needs the user's go-ahead. That's an
        // **expected** control-flow signal, not an error: the turn must
        // stop, the user reviews the plan in the UI, and once they
        // decide the approval handler in @fretik/api executes the plan
        // server-side and **mutates this very tool result** in-place
        // (cf. `services/ai/update-tool-part-output.ts`), replacing the
        // `approval_pending` payload below with the final outcome
        // (`approval_granted` + result, or `approval_rejected` +
        // feedback). The agent's next turn — triggered by the front via
        // `chat.sendMessage` with a hidden metadata marker — then sees
        // the actual result in history and just summarises; it never
        // re-runs python with the same code.
        //
        // We DO NOT classify this as an `error` (no `error` key, no
        // traceback message) because the model would otherwise treat it
        // as a failure to retry or apologise for. The `message` field
        // gives the model a one-liner that explains the pause in plain
        // English.
        if (result.error.name === "ApprovalPending") {
          const approvalId =
            extractApprovalId(result.error.value) ?? dispatchedApprovalId;
          if (approvalId !== undefined) {
            return approvalPending(approvalId);
          }
          // Fall through to the generic error path — message did not
          // carry a UUID, which would indicate a malformed exception
          // from the SDK and is worth surfacing to the model verbatim.
        }
        return {
          error: `${result.error.name}: ${result.error.value}`,
          code: TOOL_ERROR_CODES.PYTHON_ERROR,
          stdout: result.stdout,
          stderr: result.error.traceback ?? result.stderr,
        };
      }

      // Cell ran without raising, but `run_plan` still created a pending
      // approval (the agent swallowed `ApprovalPending` or printed the ops).
      // Surface it anyway so the approval card renders and the turn pauses.
      if (dispatchedApprovalId !== undefined) {
        return approvalPending(dispatchedApprovalId);
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

/**
 * The `python` tool output that pauses the turn and tells the frontend to
 * render the approval card (keyed on `status: "approval_pending"` +
 * `approvalId`). Shared by the uncaught-exception path and the swallowed /
 * print-only fallback driven by the dispatcher's out-of-band signal.
 */
const approvalPending = (approvalId: string) => ({
  status: "approval_pending" as const,
  approvalId,
  message:
    "⏸ Approval required — paused before any write ran. Stop here; you'll be resumed automatically once the user decides, with the outcome replacing this result.",
});

/**
 * Pull the approval UUID out of `ApprovalPending`'s error message.
 *
 * The Python SDK builds the message as `f"Plan {approval_id} awaiting
 * user approval"` (see `sandbox-assets/fretik_apps/_runtime.py`). We
 * match on a v4-or-v7 UUID inside that string rather than parsing the
 * full sentence so a future tweak to the wording doesn't silently
 * break the bridge — the UUID is the load-bearing piece.
 */
const APPROVAL_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const extractApprovalId = (message: string): string | undefined => {
  const m = APPROVAL_UUID_RE.exec(message);
  return m?.[0];
};
