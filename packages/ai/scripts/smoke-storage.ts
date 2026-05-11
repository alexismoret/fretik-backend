/**
 * Integration smoke test for the sandbox-first conversation storage
 * façade. Runs against the real E2B sandbox, real S3, and real Redis
 * — exercises the full end-to-end behaviour the unit tests can only
 * approximate.
 *
 * Run with:
 *   cd backend/packages/ai && bun --env-file=.env run scripts/smoke-storage.ts
 *
 * What it does:
 *   1. Picks a fresh conversation id (random UUID).
 *   2. Calls `attachUserFile()` → verifies the file landed in
 *      `/workspace/attachments/` AND that it was mirrored to S3.
 *   3. Calls `writeFile()` for `outputs/report.md` → idem.
 *   4. Calls `prepareSandbox()` → verifies the bundled skills tree is
 *      reachable at `/workspace/skills/<name>/SKILL.md`.
 *   5. Runs `python` in the sandbox to verify `from skill_loader import
 *      load_skill, list_skills` works AND that `load_skill("pdf")`
 *      adds scripts/ to sys.path.
 *   6. Runs `bash` to grep the attachments file we just wrote.
 *   7. Calls `mirrorSandboxChanges()` for an artifact written in step 5
 *      → verifies S3 backup happened.
 *   8. Cleans up: deletes the conversation's S3 mirror.
 *
 * Step 5 is the real moneyshot — it validates that the E2B template
 * baked the skill_loader correctly AND that the per-sandbox skill
 * push works.
 *
 * Exits non-zero on the first failure so the script can be wired
 * into CI later.
 */

import { listSessionPaths } from "@fretik/shared/lib/chatbot-session-storage";
import { killSandbox } from "@fretik/shared/services/e2b/kill-sandbox";
import { runInSandbox } from "@fretik/shared/services/e2b/run-in-sandbox";
import { randomUUID } from "node:crypto";
import {
  attachUserFile,
  deleteConversationStorage,
  fileExists,
  listFiles,
  mirrorSandboxChanges,
  prepareSandbox,
  readFileText,
  writeFile,
} from "../src/lib/conversation-storage";

const conversationId = randomUUID();

// --------------------------------------------------------------- //
// Helpers                                                          //
// --------------------------------------------------------------- //

let stepIndex = 0;
const step = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
  stepIndex += 1;
  const tag = `[${stepIndex.toString().padStart(2, "0")}] ${label}`;
  const start = Date.now();
  try {
    const result = await fn();
    console.log(`✓ ${tag} (${(Date.now() - start).toString()}ms)`);
    return result;
  } catch (err) {
    console.error(
      `✗ ${tag} — ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
};

const assert = (cond: boolean, message: string): void => {
  if (!cond) throw new Error(`Assertion failed: ${message}`);
};

// --------------------------------------------------------------- //
// Smoke flow                                                       //
// --------------------------------------------------------------- //

const main = async (): Promise<void> => {
  console.log(`\n=== conversation: ${conversationId} ===\n`);

  try {
    // 1. Bootstrap an empty sandbox.
    await step("prepareSandbox (cold start)", async () => {
      await prepareSandbox(conversationId);
    });

    // 2. Verify skills tree reachable inside the sandbox via a python
    //    `os.listdir` — keeps us free of a direct e2b SDK import here.
    await step(
      "skills/<name>/SKILL.md present in sandbox after bootstrap",
      async () => {
        const probe = await runInSandbox(conversationId, {
          language: "python",
          code: [
            "import os, json",
            "root = '/workspace/skills'",
            "names = sorted(",
            "    n for n in os.listdir(root)",
            "    if os.path.isdir(os.path.join(root, n)) and not n.startswith('.')",
            ")",
            "missing = [",
            "    n for n in names",
            "    if not os.path.isfile(os.path.join(root, n, 'SKILL.md'))",
            "]",
            "print(json.dumps({'names': names, 'missing': missing}))",
          ].join("\n"),
        });
        if (probe.error) {
          throw new Error(
            `skills probe failed: ${probe.error.name}: ${probe.error.value}`,
          );
        }
        const parsed = JSON.parse(probe.stdout.trim()) as {
          names: string[];
          missing: string[];
        };
        assert(parsed.names.length > 0, "no skill bundles found in sandbox");
        assert(
          parsed.missing.length === 0,
          `SKILL.md missing in: ${parsed.missing.join(", ")}`,
        );
        console.log(`    skills: ${parsed.names.join(", ")}`);
      },
    );

    // 3. Attach a user file.
    await step("attachUserFile invoice.pdf", async () => {
      const result = await attachUserFile(
        conversationId,
        "invoice.pdf",
        new TextEncoder().encode("Invoice #42\nTotal: 100 EUR\n"),
      );
      assert(
        result.path === "attachments/invoice.pdf",
        `path mismatch: ${result.path}`,
      );
      assert(
        await fileExists(conversationId, "attachments/invoice.pdf"),
        "attachments/invoice.pdf missing in sandbox",
      );
    });

    // 4. Write to outputs/.
    await step("writeFile outputs/report.md", async () => {
      await writeFile(
        conversationId,
        "outputs/report.md",
        "# Report\n\nLine A\nLine B\nLine C\n",
      );
      const text = await readFileText(conversationId, "outputs/report.md");
      assert(text.includes("Line A"), "outputs/report.md content mismatch");
    });

    // 5. Verify S3 backup landed (give the async queue a moment).
    await step("S3 mirror picked up attachments + outputs", async () => {
      // The fire-and-forget chain should drain in a few hundred ms.
      await new Promise((r) => setTimeout(r, 800));
      const paths = await listSessionPaths(conversationId);
      console.log(`    S3 paths: ${paths.join(", ")}`);
      assert(
        paths.includes("attachments/invoice.pdf"),
        "attachments/invoice.pdf not mirrored to S3",
      );
      assert(
        paths.includes("outputs/report.md"),
        "outputs/report.md not mirrored to S3",
      );
    });

    // 6. Run python: validate skill_loader works.
    await step(
      "python: skill_loader importable + load_skill() works",
      async () => {
        const result = await runInSandbox(conversationId, {
          language: "python",
          code: [
            "from skill_loader import load_skill, list_skills, skill_path",
            "skills = list_skills()",
            "print(f'SKILLS={sorted(skills)}')",
            "if 'pdf' in skills:",
            "    p = load_skill('pdf')",
            "    print(f'PDF_SCRIPTS_DIR={p}')",
            "elif skills:",
            "    p = load_skill(skills[0])",
            "    print(f'FIRST_SKILL_DIR={p}')",
            "print('SKILL_LOADER_OK')",
          ].join("\n"),
        });
        if (result.error) {
          throw new Error(
            `python error: ${result.error.name}: ${result.error.value}\n${result.error.traceback ?? ""}`,
          );
        }
        const stdout = result.stdout;
        console.log(`    python stdout: ${stdout.replace(/\n/g, " | ")}`);
        assert(
          stdout.includes("SKILL_LOADER_OK"),
          "skill_loader did not complete cleanly",
        );
        assert(
          /SKILLS=\[(.|\n)*?\]/.test(stdout) && !stdout.includes("SKILLS=[]"),
          "list_skills() returned an empty list — skills/ not pushed?",
        );
      },
    );

    // 7. Run bash to grep our outputs/report.md.
    await step("bash: grep outputs/report.md", async () => {
      const result = await runInSandbox(conversationId, {
        language: "bash",
        code: "wc -l outputs/report.md && grep 'Line B' outputs/report.md",
      });
      if (result.error) {
        throw new Error(
          `bash error: ${result.error.name}: ${result.error.value}`,
        );
      }
      assert(
        result.stdout.includes("Line B"),
        "bash didn't see Line B in outputs/report.md",
      );
    });

    // 8. Run python: write a new file under outputs/, then mirror it.
    await step(
      "python writes outputs/derived.txt → mirrorSandboxChanges → S3",
      async () => {
        const result = await runInSandbox(conversationId, {
          language: "python",
          code: [
            "with open('outputs/derived.txt', 'w') as f:",
            "    f.write('hello from python\\n')",
            "print('WROTE')",
          ].join("\n"),
        });
        if (result.error) {
          throw new Error(
            `python error: ${result.error.name}: ${result.error.value}`,
          );
        }
        // Manual mirror (the python tool wires this automatically; we
        // just want to verify mirrorSandboxChanges works in isolation).
        await mirrorSandboxChanges(
          conversationId,
          [{ path: "outputs/derived.txt", mime: "text/plain", size: 18 }],
          [],
        );
        // Drain the backup chain.
        await new Promise((r) => setTimeout(r, 600));
        const paths = await listSessionPaths(conversationId);
        assert(
          paths.includes("outputs/derived.txt"),
          "outputs/derived.txt not mirrored to S3 after mirrorSandboxChanges",
        );
      },
    );

    // 9. listFiles narrows to attachments.
    await step("listFiles narrows to attachments/", async () => {
      const attachments = await listFiles(conversationId, "attachments");
      const paths = attachments.map((f) => f.path);
      assert(
        paths.includes("attachments/invoice.pdf"),
        `expected invoice.pdf in attachments listing, got: ${paths.join(", ")}`,
      );
    });

    console.log("\n=== all steps green ===\n");
  } finally {
    // Cleanup
    await step("cleanup: deleteConversationStorage + killSandbox", async () => {
      await deleteConversationStorage(conversationId);
      try {
        await killSandbox(conversationId);
      } catch {
        // Best-effort.
      }
    });
  }
};

main().catch((err) => {
  console.error(
    `\nSMOKE TEST FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
