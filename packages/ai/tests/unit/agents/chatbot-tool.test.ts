import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  buildChatbotTool,
  type ChatbotTool,
} from "../../../src/agents/shared/chatbot-tool";
import { TOOL_ERROR_CODES } from "../../../src/lib/tool-error-codes";

/**
 * The throw guard in `buildChatbotTool` is the backstop that makes the
 * "tools never throw" convention a guarantee: an unexpected throw or promise
 * rejection becomes a canonical `{ error, code: INTERNAL_ERROR }` the model
 * reads as a normal result, instead of a raw stream error.
 */

/**
 * Generic in the tool's own input/output: `ReturnType<typeof buildChatbotTool>`
 * is `ChatbotTool<unknown, unknown>`, and those parameters are invariant, so a
 * concrete tool built in a test is NOT assignable to it. Every call here was
 * rejected the moment this file entered the typecheck.
 */
const run = async <TInput, TOutput>(
  tool: ChatbotTool<TInput, TOutput>,
  input: TInput,
): Promise<unknown> => {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute fn");
  return await Promise.resolve(
    execute(input, { toolCallId: "call-test", messages: [], context: {} }),
  );
};

const isInternalError = (
  out: unknown,
): out is { error: string; code: string } =>
  typeof out === "object" &&
  out !== null &&
  "code" in out &&
  out.code === TOOL_ERROR_CODES.INTERNAL_ERROR;

describe("buildChatbotTool — throw guard", () => {
  test("a synchronous throw becomes INTERNAL_ERROR, not a thrown error", async () => {
    const tool = buildChatbotTool({
      category: "core",
      searchHint: "boom sync",
      description: "throws synchronously",
      inputSchema: z.object({}),
      // Annotated because a body that only throws infers `never` as the tool's
      // output, and the SDK's tool type maps a `never` output to `execute?:
      // undefined` — the function then has nothing to be assignable to.
      execute: (): { value: number } => {
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
      // Same reason as the synchronous case above.
      execute: async (): Promise<{ value: number }> => {
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
