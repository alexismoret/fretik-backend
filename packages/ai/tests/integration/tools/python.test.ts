/**
 * Unit tests for the `python` tool. Focus on the **contract** the tool
 * exposes to the agent — kernel-restart wiring, rich-result
 * forwarding, toolCallId propagation, error mapping. The actual
 * "kernel state persists across calls" claim is exercised by the
 * tabular-extraction eval against the real E2B sandbox; here we
 * stub the sandbox layer and assert the tool calls it the right
 * way.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getProfileForRole } from "../../../src/lib/model-registry/resolve";
import { installSandboxMocks, sandboxFs } from "../../lib/sandbox-fixture";

installSandboxMocks();

// --------------------------------------------------------------- //
// run-in-sandbox + restart-python-kernel mocks                    //
// --------------------------------------------------------------- //
// These intercept the two boundaries the python tool depends on.
// Tests can read `runCalls` / `restartCalls` to assert the tool
// invoked them the right way, and can drive the next return value
// via `nextRunResult`.

interface CapturedRunCall {
  conversationId: string;
  language: "python" | "bash";
  code: string;
  toolCallId?: string;
}

const runCalls: CapturedRunCall[] = [];
const restartCalls: string[] = [];
/**
 * Single ordered log of every cross-boundary call (restartPythonKernel
 * + runInSandbox) so tests can assert interleaving without having to
 * re-mock modules mid-suite (mock.module across tests leaks state).
 */
const callOrder: string[] = [];

interface MockRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: { name: string; value: string; traceback?: string };
  artifacts: { path: string; mime: string; size: number }[];
  deletedPaths: string[];
  richResults: {
    kind: string;
    isMainResult: boolean;
    preview?: string;
    artifactPath?: string;
    chart?: unknown;
  }[];
}

let nextRunResult: MockRunResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  artifacts: [],
  deletedPaths: [],
  richResults: [],
};

let nextRestartError: Error | null = null;

void mock.module("@fretik/shared/services/e2b/run-in-sandbox", () => ({
  runInSandbox: async (
    conversationId: string,
    options: {
      language: "python" | "bash";
      code: string;
      toolCallId?: string;
    },
  ) => {
    runCalls.push({
      conversationId,
      language: options.language,
      code: options.code,
      toolCallId: options.toolCallId,
    });
    callOrder.push(`run:${conversationId}:${options.code}`);
    return nextRunResult;
  },
}));

void mock.module("@fretik/shared/services/e2b/restart-python-kernel", () => ({
  restartPythonKernel: async (conversationId: string) => {
    restartCalls.push(conversationId);
    callOrder.push(`restart:${conversationId}`);
    if (nextRestartError) throw nextRestartError;
  },
}));

// Stub the Redis-backed approval signal so the tool's post-run consume()
// doesn't reach for a real Redis. `nextPendingApprovalId` lets a test drive
// the swallowed-ApprovalPending → approval_pending fallback path.
let nextPendingApprovalId: string | undefined;
void mock.module("@fretik/shared/services/approvals/sandbox-signal", () => ({
  consumeSandboxApprovalPending: async () => nextPendingApprovalId,
  markSandboxApprovalPending: async () => undefined,
}));

// --------------------------------------------------------------- //
// SUT imports — must come AFTER mocks                              //
// --------------------------------------------------------------- //

const { createPythonTool } = await import("../../../src/tools/python");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const buildOptions = (conversationId: string, toolCallId: string) => {
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    modelProfile: getProfileForRole("chat"),
    dynamicToolManager: new DynamicToolManager(),
  };
  return {
    toolCallId,
    messages: [] as never[],
    context: wrapRuntimeContext(ctx),
  };
};

const execPython = async (
  conversationId: string,
  args: { code: string; restart?: boolean },
  toolCallId = `tc-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
): Promise<unknown> => {
  const tool = createPythonTool();
  if (typeof tool.execute !== "function") {
    throw new Error("python tool missing execute");
  }
  return tool.execute(args, buildOptions(conversationId, toolCallId));
};

const setRunResult = (overrides: Partial<MockRunResult>): void => {
  nextRunResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    artifacts: [],
    deletedPaths: [],
    richResults: [],
    ...overrides,
  };
};

beforeEach(() => {
  sandboxFs.reset();
  runCalls.length = 0;
  restartCalls.length = 0;
  callOrder.length = 0;
  nextRestartError = null;
  nextPendingApprovalId = undefined;
  setRunResult({});
});

describe("python tool", () => {
  test("forwards toolCallId to runInSandbox so rich results land under outputs/results/<id>-...", async () => {
    setRunResult({ stdout: "ok\n" });
    await execPython("conv-1", { code: "print('ok')" }, "tc-stable-id");

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]?.toolCallId).toBe("tc-stable-id");
    expect(runCalls[0]?.language).toBe("python");
  });

  test("surfaces approval_pending from the dispatcher signal even when the cell swallowed ApprovalPending", async () => {
    // Cell ran without raising (agent wrapped run_plan in try/except), but
    // the dispatcher created a pending approval and stamped the signal.
    setRunResult({ stdout: "Résultat run_plan: ApprovalPending: ...\n" });
    nextPendingApprovalId = "019efa94-fa47-78c3-8547-0cab7d307686";

    const out = await execPython("conv-approval", {
      code: "try:\n    run_plan([op])\nexcept Exception as e:\n    print(e)",
    });

    expect(out).toMatchObject({
      status: "approval_pending",
      approvalId: "019efa94-fa47-78c3-8547-0cab7d307686",
    });
  });

  test("a normal cell with no approval signal returns the stdout payload", async () => {
    setRunResult({ stdout: "hello\n" });

    const out = await execPython("conv-normal", { code: "print('hello')" });

    expect((out as { status?: unknown }).status).toBeUndefined();
    expect(out).toMatchObject({ stdout: "hello\n" });
  });

  test("rejects with NO_CONVERSATION when no conversationId is in the runtime context", async () => {
    const tool = createPythonTool();
    if (typeof tool.execute !== "function") {
      throw new Error("python tool missing execute");
    }
    const ctx = {
      organizationId: "org-1",
      teamId: "team-1",
      conversationId: undefined,
      modelProfile: getProfileForRole("chat"),
      dynamicToolManager: new DynamicToolManager(),
    };
    const result = await tool.execute(
      { code: "print(1)" },
      {
        toolCallId: "tc-1",
        messages: [] as never[],
        context: wrapRuntimeContext(ctx),
      },
    );
    expect(result).toEqual({
      error:
        "python requires an active conversation context. No conversationId was provided.",
      code: "NO_CONVERSATION",
    });
    expect(runCalls).toHaveLength(0);
  });

  test("does NOT call restartPythonKernel when restart is omitted (state persists by default)", async () => {
    setRunResult({ stdout: "first\n" });
    await execPython("conv-state", { code: "x = 42" });
    setRunResult({ stdout: "second\n" });
    await execPython("conv-state", { code: "print(x)" });

    expect(restartCalls).toHaveLength(0);
    expect(runCalls).toHaveLength(2);
  });

  test("calls restartPythonKernel BEFORE runInSandbox when restart: true (kernel reset, then run)", async () => {
    setRunResult({ stdout: "after-restart\n" });
    await execPython(
      "conv-restart",
      { code: "print('hello')", restart: true },
      "tc-restart-1",
    );

    expect(callOrder).toEqual([
      "restart:conv-restart",
      "run:conv-restart:print('hello')",
    ]);
  });

  test("returns a sandbox-error envelope when restartPythonKernel throws", async () => {
    nextRestartError = new Error("kernel daemon unreachable");

    const result = await execPython("conv-restart-fail", {
      code: "print(1)",
      restart: true,
    });

    expect(result).toMatchObject({
      code: expect.any(String),
      error: expect.stringContaining("Python kernel"),
    });
    // runInSandbox must NOT have been called once restart failed.
    expect(runCalls).toHaveLength(0);
  });

  test("surfaces richResults verbatim on the success payload", async () => {
    setRunResult({
      stdout: "",
      richResults: [
        {
          kind: "html",
          isMainResult: true,
          preview: "<table><tr><th>a</th></tr><tr><td>1</td></tr></table>",
        },
        {
          kind: "png",
          isMainResult: false,
          artifactPath: "outputs/results/tc-rich-0.png",
        },
      ],
      artifacts: [
        {
          path: "outputs/results/tc-rich-0.png",
          mime: "image/png",
          size: 128,
        },
      ],
    });

    const result = (await execPython(
      "conv-rich",
      { code: "df.head(); plt.show()" },
      "tc-rich",
    )) as {
      richResults: { kind: string; isMainResult: boolean }[];
      artifacts: { path: string }[];
    };

    expect(result.richResults).toHaveLength(2);
    expect(result.richResults[0]).toMatchObject({
      kind: "html",
      isMainResult: true,
    });
    expect(result.richResults[1]).toMatchObject({
      kind: "png",
      artifactPath: "outputs/results/tc-rich-0.png",
    });
    expect(result.artifacts).toEqual([
      {
        path: "outputs/results/tc-rich-0.png",
        mime: "image/png",
        size: 128,
      },
    ]);
  });

  test("maps a kernel exception to PYTHON_ERROR with traceback in stderr", async () => {
    setRunResult({
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: {
        name: "NameError",
        value: "name 'df' is not defined",
        traceback:
          "Traceback (most recent call last):\n  File \"<cell>\", line 1, in <module>\n    df.head()\nNameError: name 'df' is not defined",
      },
      artifacts: [],
      deletedPaths: [],
      richResults: [],
    });

    const result = (await execPython("conv-err", { code: "df.head()" })) as {
      error: string;
      code: string;
      stderr: string;
    };

    expect(result.code).toBe("PYTHON_ERROR");
    expect(result.error).toBe("NameError: name 'df' is not defined");
    expect(result.stderr).toContain("NameError");
  });
});
