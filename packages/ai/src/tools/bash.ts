import { runInSandbox } from "@fretik/shared/services/e2b/run-in-sandbox";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  mirrorSandboxChanges,
  prepareSandbox,
} from "../lib/conversation-storage";
import { maybePersistLargeOutput } from "../lib/persisted-output";
import { withSlot } from "../lib/rate-limit";
import { mapE2BError } from "./_e2b-errors";

/**
 * Per-conversation E2B execution mutex (capacity 1) — SAME key
 * namespace as `tools/python.ts` so every sandbox-touching call
 * across `bash` + `python` on the SAME `conversationId` serialises
 * through one shared lock. Bash itself is a fresh subprocess (no
 * kernel state) but it still shares the sandbox's 1 vCPU / 1 GB AND
 * the `/workspace` filesystem with `python`. Without this mutex,
 * `bash rm file` racing against `python pd.read_csv(file)` would
 * corrupt the workspace, and concurrent heavy commands (find,
 * grep -R, tar) compete for the same CPU/RAM as a running Python
 * cell — both observed to trigger E2B timeouts under load when
 * sub-agents fan out via `dispatchAgent`.
 */
const E2B_EXEC_HOLD_TIMEOUT_MS = 5 * 60 * 1000 + 30_000;
const e2bExecMutexKey = (conversationId: string): string =>
  `e2b:exec:${conversationId}`;

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
      "Run a single bash command in the conversation's E2B sandbox under `/workspace`. Same filesystem as `python` (files written by either are visible to the other), independent state.",
      "",
      "Usage:",
      "- Use for shell-native operations: `ls`, `find`, `grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `sed`, `awk`, `diff`, `tar`, pipelines, `mv` / `cp` / `rm` / `mkdir`.",
      "- Use for `pip install <pkg>` for one-off packages (then `restart: true` on the next `python` call to pick it up).",
      "- For viewing a single file → use `read` instead (handles PDF/DOCX/PPTX sidecars, line numbering).",
      "- For pandas / numpy / chart generation / structured data work → use `python` instead (don't `bash python3 -c \"...\"` — you'd lose the persistent kernel).",
      "- For HTTP fetches → use `searchWeb` / `webFetch` (sandbox egress is restricted to PyPI / GitHub / Fretik / carrier APIs).",
      "- Each call is a fresh `bash -c` subprocess. Env vars, shell variables, `cd`, aliases, `source`d files do NOT persist between calls. Chain with `&&` / `;` / `|` / heredocs in one call when needed.",
      "- Files under `/workspace` DO persist across calls. Files you create under `attachments/` or `outputs/` are auto-mirrored to durable storage — call `presentFiles` to surface generated files to the user.",
      "- Sandbox: 1 vCPU, 1 GB memory, 5 min wall-clock, non-root user.",
      "- `restart: true` KILLS AND RECREATES the entire sandbox (wipes `/workspace`!). Escape hatch for filesystem corruption only — for kernel-only reset use `python` with `restart: true` instead.",
      "",
      "Output: `{ stdout, stderr, artifacts: [{path, mime, size}] }`. Large outputs are swapped for a `<persisted-output>` envelope — pre-filter with `| head -N` or `| wc -l` when possible.",
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

      // Serialise sandbox execution per conversation — see the
      // `e2bExecMutexKey` docblock at the top of this file.
      let result;
      try {
        result = await withSlot(
          e2bExecMutexKey(conversationId),
          1,
          E2B_EXEC_HOLD_TIMEOUT_MS,
          () =>
            runInSandbox(conversationId, {
              language: "bash",
              code: command,
              restart,
            }),
        );
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
