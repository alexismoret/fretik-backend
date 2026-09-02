import { beforeEach, describe, expect, test } from "bun:test";
import { CommandExitError } from "e2b";
import { mockModule } from "../lib/mock-module";

/**
 * `sbx.commands.run()` THROWS `CommandExitError` on a non-zero exit — it does
 * not return a result with `exitCode !== 0`. `run-in-sandbox`'s bash branch
 * read `result.exitCode`, so that check was dead code and the throw escaped to
 * the `bash` tool's catch-all, which mapped it to `SANDBOX_UNAVAILABLE` and
 * dropped stdout/stderr.
 *
 * Measured cost of that (prod trace `9b8244165bc4c9f5…`, 2026-08-26): a node
 * SyntaxError reached the model as "Sandbox error while running bash in
 * sandbox: exit status 1" with no output at all, so it spent ~8 of its 30
 * steps probing the sandbox for a fault that did not exist and hit the step
 * budget mid-task.
 *
 * These tests pin the contract: a non-zero exit is a RESULT — `exitCode`,
 * `stdout` and `stderr` all survive, and nothing throws.
 */

interface FakeCommandOpts {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

interface Scenario {
  /** Thrown by `commands.run` when set, otherwise the result it resolves to. */
  outcome:
    | { kind: "throw"; error: unknown }
    | { kind: "resolve"; exitCode: number; stdout: string; stderr: string };
  /** Chunks pushed through the streaming callbacks before settling. */
  streamed?: { stdout?: string; stderr?: string };
}

let scenario: Scenario;
let lastRunOpts: FakeCommandOpts & { timeoutMs?: number; cwd?: string };

// The SDK itself is never mocked: `runInSandbox` reaches the sandbox only
// through `lease.sandbox`, so overriding `acquireSandbox` — a first-party
// module — is enough, and no process-wide fake of `@e2b/code-interpreter`
// leaks into the other suites sharing this test process.
const fakeSandbox = {
  files: {
    list: async () => [],
    write: async () => undefined,
  },
  commands: {
    run: async (
      _cmd: string,
      opts: FakeCommandOpts & { timeoutMs?: number; cwd?: string },
    ) => {
      lastRunOpts = opts;
      if (scenario.streamed?.stdout) opts.onStdout?.(scenario.streamed.stdout);
      if (scenario.streamed?.stderr) opts.onStderr?.(scenario.streamed.stderr);
      if (scenario.outcome.kind === "throw") throw scenario.outcome.error;
      const { exitCode, stdout, stderr } = scenario.outcome;
      return { exitCode, stdout, stderr };
    },
  },
};

await mockModule("../../src/services/e2b/acquire-sandbox", {
  acquireSandbox: async (conversationId: string) => ({
    sandboxId: "sbx-test",
    conversationId,
    sandbox: fakeSandbox,
  }),
});
await mockModule("../../src/services/e2b/kill-sandbox", {
  killSandbox: async () => undefined,
});

const { runInSandbox } = await import("../../src/services/e2b/run-in-sandbox");

const runBash = async (code = "false") =>
  runInSandbox("conv-test", { language: "bash", code });

describe("runInSandbox — bash non-zero exit", () => {
  beforeEach(() => {
    scenario = {
      outcome: { kind: "resolve", exitCode: 0, stdout: "", stderr: "" },
    };
  });

  test("a CommandExitError is unwrapped into a result, not thrown", async () => {
    scenario = {
      outcome: {
        kind: "throw",
        error: new CommandExitError({
          exitCode: 1,
          error: "exit status 1",
          stdout: "wrote 379 lines\n",
          stderr: "SyntaxError: await is only valid in async functions\n",
        }),
      },
    };

    const result = await runBash();

    expect(result.exitCode).toBe(1);
    // The whole point: the diagnostics reach the model.
    expect(result.stdout).toBe("wrote 379 lines\n");
    expect(result.stderr).toBe(
      "SyntaxError: await is only valid in async functions\n",
    );
    expect(result.error?.name).toBe("NonZeroExit");
    expect(result.error?.value).toContain("exit code 1");
    // The SDK's own message is kept — it is what Langfuse shows as the
    // observation's statusMessage.
    expect(result.error?.value).toContain("exit status 1");
  });

  test("streamed chunks win over the error's accumulators", async () => {
    scenario = {
      outcome: {
        kind: "throw",
        error: new CommandExitError({
          exitCode: 2,
          error: "exit status 2",
          stdout: "ignored",
          stderr: "ignored",
        }),
      },
      streamed: { stdout: "live-out", stderr: "live-err" },
    };

    const result = await runBash();

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("live-out");
    expect(result.stderr).toBe("live-err");
    expect(result.error?.value).toContain("exit code 2");
  });

  test("an error that is not a CommandExitError still propagates", async () => {
    scenario = {
      outcome: { kind: "throw", error: new Error("sandbox really is down") },
    };

    const thrown: unknown = await runBash().then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toBe(
      "sandbox really is down",
    );
  });

  test("exit 0 stays a clean result", async () => {
    scenario = {
      outcome: {
        kind: "resolve",
        exitCode: 0,
        stdout: "deps OK\n",
        stderr: "",
      },
    };

    const result = await runBash("node -e \"console.log('deps OK')\"");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("deps OK\n");
    expect(result.error).toBeUndefined();
  });

  test("the exec is given the 5 min cap, not the SDK's 60 s default", async () => {
    await runBash();
    expect(lastRunOpts.timeoutMs).toBe(5 * 60 * 1000);
    expect(lastRunOpts.cwd).toBe("/workspace");
  });
});

describe("runInSandbox — bash abort", () => {
  beforeEach(() => {
    scenario = {
      outcome: { kind: "resolve", exitCode: 0, stdout: "", stderr: "" },
    };
  });

  test("the abort signal is forwarded so the sandbox is not killed", async () => {
    const controller = new AbortController();
    await runInSandbox("conv-test", {
      language: "bash",
      code: "sleep 1",
      abortSignal: controller.signal,
    });
    // `commands.run` accepts an AbortSignal (unlike `runCode`). Forwarding it
    // is what lets a user Stop cancel in band instead of killing the sandbox
    // and wiping /workspace.
    expect(lastRunOpts.signal).toBe(controller.signal);
  });

  test("an already-aborted turn returns the Aborted marker", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runInSandbox("conv-test", {
      language: "bash",
      code: "sleep 1",
      abortSignal: controller.signal,
    });
    expect(result.error?.name).toBe("Aborted");
  });
});
