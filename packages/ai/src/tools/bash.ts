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
 * Aligned with Anthropic's `bash_code_execution` and Claude Code's
 * `Bash`:
 *  - input fields: `command` (mandatory), `description?`, `restart?`
 *  - output on success: `{ stdout, stderr, artifacts }`
 *  - output on failure: `{ error, code, stdout?, stderr? }`
 *
 * Each call spawns a **fresh `bash -c` subprocess** inside the
 * conversation's sandbox via `commands.run`. Shell variables, env
 * vars, `cd`, aliases, sourced files do NOT persist to the next call
 * — the kernel-style persistence the `python` tool offers is
 * specific to the Jupyter kernel and does not apply here.
 *
 * Same `/workspace` filesystem as the `python` tool — files written
 * by either are visible to the other.
 *
 * Two distinct restart semantics in this codebase:
 *  - `bash` `restart: true` (this file) → kills and recreates the
 *    entire sandbox (`runInSandbox({ restart: true })` →
 *    `killSandbox`). `/workspace` is wiped. Heavy-handed escape
 *    hatch reserved for filesystem corruption.
 *  - `python` `restart: true` → resets only the Jupyter kernel
 *    (`restartPythonKernel` → `sbx.restartCodeContext`).
 *    `/workspace` is preserved.
 *
 * `prepareSandbox` ensures the workspace layout is initialised
 * (skill bundles pushed, `attachments/` / `outputs/` restored from
 * S3 on cold start) before the command runs. After execution,
 * `mirrorSandboxChanges` copies any created/modified files under
 * `attachments/` or `outputs/` to S3 so a future cold sandbox can be
 * restored.
 */

export const bashInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "Bash command to run in the conversation's sandbox under /workspace. Fresh subprocess every call — env vars, cwd, shell variables, `source` do NOT persist between calls. Filesystem under /workspace persists. Chain in one call with &&, ;, |, heredocs.",
    ),
  description: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "5–10 word gloss of what this command does (e.g. 'List CSV files in workspace'). Rendered above the raw command in the UI so the user can scan the chat without parsing shell syntax.",
    ),
  restart: z
    .boolean()
    .optional()
    .describe(
      "If true, KILL AND RECREATE THE ENTIRE SANDBOX before running — `/workspace` is wiped, all attachments and outputs are lost (they will be re-restored from S3 on the next call). Heavy-handed escape hatch for filesystem corruption only. To reset just the Python kernel without losing files, use the `python` tool's `restart` parameter instead.",
    ),
});

export const createBashTool = () =>
  tool({
    description: [
      "Executes a single bash command in the conversation's E2B sandbox. Same `/workspace` as the `python` tool — files written by either are visible to the other.",
      "",
      "Execution model — fresh subprocess per call, stateful filesystem:",
      '- Each call is a fresh `bash -c "<command>"` invocation with cwd `/workspace`. Env vars, shell variables, `cd` changes, aliases, and `source`d files do NOT persist between calls. Chain in one call with `&&` / `;` / heredocs when you need them in the same shell.',
      "- The `python` tool runs against a separate Jupyter kernel that DOES keep state across calls. `bash` cannot read Python variables and vice versa — they share only the filesystem. If you `pip install` a package via `bash`, restart the Python kernel (`python` tool with `restart: true`) before importing it.",
      "- Files under `/workspace` DO persist across calls within the same conversation, including artifacts produced by `python`. Reference them by relative path (`ls`, `grep pattern attachments/invoice.csv`).",
      "- Conversation files (user uploads, previous tool outputs) are synced into `/workspace` before every call.",
      "- Files you create, modify, or delete come back as structured artifacts (path/mime/size) / `deletedPaths`. Call `presentFiles` afterwards to surface generated files — a bare bash write does not show anything by itself.",
      "",
      "Sandbox: 1 vCPU, 1 GB memory, 5 min wall-clock timeout, non-root user, /workspace as cwd. Outbound internet is restricted to a curated allowlist (PyPI, GitHub, Fretik, common carrier APIs).",
      "",
      "When to use:",
      "- `ls`, `find`, `grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `sed`, `awk`, `diff`, `tar`, pipelines — anything shell-native.",
      "- Quick file inspection where `read` would be overkill (`wc -l *.csv`, `head -5 data.json`).",
      "- File movement: `mv`, `cp`, `rm`, `mkdir`.",
      "- `pip install <pkg>` for one-off packages not in the pre-installed list (then `restart: true` on the next `python` call).",
      "",
      "When NOT to use — pick a more specialized tool:",
      "- To view a single file's contents → `read` (handles PDF/DOCX sidecars, line numbering, persisted-output recovery).",
      "- For pandas/numpy/chart generation → `python` (don't use `bash python3 -c ...`; the `python` tool keeps a stateful kernel).",
      "- For HTTP fetches → `searchWeb` / `webFetch` (the sandbox's egress is restricted; only the allowlist works).",
      "",
      "Examples:",
      "- Count rows: `wc -l invoice.csv`",
      "- Find files: `find /workspace -name '*.pdf' -type f`",
      "- Search text: `grep -n 'container' /workspace/*.txt | head -50`",
      "- Chain: `mkdir -p out && cp *.csv out/ && ls out/`",
      "",
      "Output: `{ stdout, stderr, artifacts: [{path, mime, size}] }`. Large outputs (>30 KB serialized) are swapped for a `<persisted-output>` envelope — `read` that file to inspect. Pre-filter with `| head -N` or `| wc -l` when possible.",
    ].join("\n"),
    inputSchema: bashInputSchema,
    execute: async ({ command, description, restart }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;
      if (!ctx.conversationId) {
        return {
          error:
            "bash requires an active conversation context. No conversationId was provided.",
          code: "NO_CONVERSATION",
        };
      }
      const conversationId = ctx.conversationId;

      try {
        await prepareSandbox(conversationId);
      } catch (err) {
        return mapE2BError(err, "while preparing sandbox workspace");
      }

      let result;
      try {
        result = await runInSandbox(conversationId, {
          language: "bash",
          code: command,
          restart,
        });
      } catch (err) {
        return mapE2BError(err, "while running bash in sandbox");
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
          code: "NON_ZERO_EXIT",
          stdout: result.stdout,
          stderr: result.stderr,
          ...(description ? { description } : {}),
        };
      }

      const payload = {
        stdout: result.stdout,
        stderr: result.stderr,
        artifacts: result.artifacts,
        ...(description ? { description } : {}),
      };

      return maybePersistLargeOutput(payload, conversationId, toolCallId);
    },
  });
