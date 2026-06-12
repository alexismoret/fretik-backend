import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { buildChatbotTool } from "../../../src/agents/shared/chatbot-tool";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";

/**
 * The throw guard in `buildChatbotTool` is the backstop that makes the
 * "tools never throw" convention a guarantee: an unexpected throw or promise
 * rejection becomes a canonical `{ error, code: INTERNAL_ERROR }` the model
 * reads as a normal result, instead of a raw stream error.
 */

const run = async (
  tool: ReturnType<typeof buildChatbotTool>,
  input: unknown,
) => {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute fn");
  type ExecOptions = Parameters<NonNullable<typeof tool.execute>>[1];
  const options = {
    toolCallId: "call-test",
    messages: [],
  } as unknown as ExecOptions;
  return Promise.resolve(execute(input, options));
};

const isInternalError = (
  out: unknown,
): out is { error: string; code: string } =>
  typeof out === "object" &&
  out !== null &&
  "code" in out &&
  (out as { code: unknown }).code === TOOL_ERROR_CODES.INTERNAL_ERROR;

describe("buildChatbotTool — throw guard", () => {
  test("a synchronous throw becomes INTERNAL_ERROR, not a thrown error", async () => {
    const tool = buildChatbotTool({
      category: "core",
      searchHint: "boom sync",
      description: "throws synchronously",
      inputSchema: z.object({}),
      execute: () => {
        throw new Error("kaboom");
      },
    });
    const out = await run(tool, {});
    expect(isInternalError(out)).toBe(true);
  });

  test("a rejected promise becomes INTERNAL_ERROR", async () => {
    const tool = buildChatbotTool({
      category: "core",
      searchHint: "boom async",
      description: "rejects",
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error("async kaboom");
      },
    });
    const out = await run(tool, {});
    expect(isInternalError(out)).toBe(true);
  });

  test("a normal success result passes through unchanged", async () => {
    const tool = buildChatbotTool({
      category: "core",
      searchHint: "ok",
      description: "succeeds",
      inputSchema: z.object({}),
      execute: async () => ({ value: 42 }),
    });
    const out = await run(tool, {});
    expect(out).toEqual({ value: 42 });
  });

  test("an expected { error, code } return is preserved verbatim", async () => {
    const tool = buildChatbotTool({
      category: "core",
      searchHint: "expected error",
      description: "returns a structured error",
      inputSchema: z.object({}),
      execute: async () => ({
        error: "not found",
        code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
      }),
    });
    const out = await run(tool, {});
    expect(out).toEqual({
      error: "not found",
      code: TOOL_ERROR_CODES.FILE_NOT_FOUND,
    });
  });
});
