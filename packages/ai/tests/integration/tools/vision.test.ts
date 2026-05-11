/**
 * Unit tests for the `vision` tool. Covers the precondition gates
 * that fire BEFORE any real vision-model call: path sandboxing,
 * extension checking, and missing-file detection.
 *
 * The actual vision call is never exercised here — those tests would
 * require either a real OpenRouter key or a full fetch mock, and the
 * interesting logic lives upstream (input validation + sandbox
 * policy). Integration coverage of the vision model itself is out of
 * scope for this file.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { installSandboxMocks, sandboxFs } from "../../../lib/sandbox-fixture";

installSandboxMocks();

const { createVisionTool } = await import("../../../src/tools/vision");
const { DynamicToolManager } =
  await import("../../../src/agents/shared/dynamic-tools");
const { TaskManager } = await import("../../../src/agents/shared/task-manager");
const { wrapRuntimeContext } =
  await import("../../../src/agents/shared/runtime-context");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const buildOptions = (conversationId: string) => {
  const ctx = {
    organizationId: "org-1",
    teamId: "team-1",
    conversationId,
    dynamicToolManager: new DynamicToolManager(),
    taskManager: new TaskManager(),
  };
  return {
    toolCallId: `tc-${Date.now().toString()}`,
    messages: [] as never[],
    experimental_context: wrapRuntimeContext(ctx),
  };
};

const execVision = async (
  conversationId: string,
  file_path: string,
  question: string,
): Promise<Record<string, unknown>> => {
  const tool = createVisionTool();
  if (typeof tool.execute !== "function") {
    throw new Error("vision tool missing execute");
  }
  const result = await tool.execute(
    { file_path, question },
    buildOptions(conversationId),
  );
  if (!isRecord(result)) {
    throw new Error(`vision returned non-object: ${JSON.stringify(result)}`);
  }
  return result;
};

beforeEach(() => {
  sandboxFs.reset();
});

describe("vision tool — precondition checks", () => {
  test("rejects non-image/non-pdf extensions with UNSUPPORTED_VISION_TYPE", async () => {
    const out = await execVision(
      "conv-x",
      "attachments/note.txt",
      "What is this?",
    );
    expect(out["code"]).toBe("UNSUPPORTED_VISION_TYPE");
    expect(typeof out["error"]).toBe("string");
  });

  test("rejects spreadsheets with UNSUPPORTED_VISION_TYPE", async () => {
    const out = await execVision(
      "conv-x",
      "attachments/data.xlsx",
      "Show the chart",
    );
    expect(out["code"]).toBe("UNSUPPORTED_VISION_TYPE");
  });

  test("rejects paths outside /workspace/", async () => {
    const out = await execVision("conv-x", "/etc/passwd.png", "look at this");
    expect(out["code"]).toBe("PATH_OUT_OF_SANDBOX");
  });

  test("rejects ../ traversal", async () => {
    const out = await execVision(
      "conv-x",
      "../other-conv/secret.png",
      "look at this",
    );
    expect(out["code"]).toBe("PATH_OUT_OF_SANDBOX");
  });

  test("rejects missing image with FILE_NOT_FOUND", async () => {
    const out = await execVision("conv-x", "attachments/ghost.png", "anything");
    expect(out["code"]).toBe("FILE_NOT_FOUND");
  });

  test("rejects missing PDF with FILE_NOT_FOUND (PDFs are now a supported vision input)", async () => {
    const out = await execVision(
      "conv-x",
      "attachments/report.pdf",
      "Describe it",
    );
    expect(out["code"]).toBe("FILE_NOT_FOUND");
  });
});
