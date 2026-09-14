import type { JSONSchema7 } from "@ai-sdk/provider";
import { InvalidToolInputError, NoSuchToolError } from "ai";
import { describe, expect, mock, test } from "bun:test";
import { mockModule } from "../../lib/mock-module";

/**
 * The repairer fixes a SHAPE and never speaks for the model.
 *
 * Measured in prod (2026-09-14): an upstream host cut the stream, the step
 * ended on a tool call with EMPTY input, and the repairer filled the void with
 * `{ action: "list" }` — executed 16 times in one turn as if the model had
 * asked for it. Every case below where `resolveModel` is NOT reached is a
 * case where the SDK now hands the original error back to the model instead.
 */

const resolveModel = mock(() => {
  throw new Error("the repair reached a model on an input it must refuse");
});
await mockModule("../../../src/lib/model-registry/resolve", { resolveModel });

const { llmRepairToolCall, repairableInput } =
  await import("../../../src/agents/shared/repair-tool-call");

const schema: JSONSchema7 = {
  type: "object",
  properties: {
    caption: { type: "string" },
    action: { type: "string", enum: ["get", "list", "update"] },
    pageId: { type: "string" },
    limit: { type: "integer" },
  },
  required: ["caption", "action"],
};

const invalid = (toolInput: string) =>
  new InvalidToolInputError({
    toolName: "managePage",
    toolInput,
    cause: new Error("validation failed"),
  });

const repair = llmRepairToolCall();

const attempt = (toolInput: string, error: unknown = invalid(toolInput)) =>
  repair({
    instructions: undefined,
    system: undefined,
    messages: [],
    toolCall: {
      type: "tool-call",
      toolCallId: "call_1",
      toolName: "managePage",
      input: toolInput,
    },
    tools: {},
    inputSchema: async () => schema,
    error: error instanceof InvalidToolInputError ? error : invalidNoSuch(),
  });

const invalidNoSuch = () =>
  new NoSuchToolError({ toolName: "nope", availableTools: ["managePage"] });

describe("repairableInput", () => {
  test("nothing said, nothing to repair", () => {
    expect(repairableInput("", schema)).toBeNull();
    expect(repairableInput("   ", schema)).toBeNull();
    expect(repairableInput("{}", schema)).toBeNull();
  });

  test("a cut mid-value is a truncation, not a shape to fix", () => {
    expect(
      repairableInput(
        '{"caption":"x","action":"update","edits":[{"file":"a.vue","content":"<temp',
        schema,
      ),
    ).toBeNull();
  });

  test("a missing required key is a fact the repairer cannot invent", () => {
    expect(repairableInput('{"caption":"x","pageId":"p1"}', schema)).toBeNull();
  });

  test("a missing caption is not a fact — the runtime defaults it", () => {
    expect(repairableInput('{"action":"list"}', schema)).toEqual({
      action: "list",
    });
  });

  test("every required key present with a wrong shape is repairable", () => {
    expect(
      repairableInput('{"caption":"x","action":"list","limit":"10"}', schema),
    ).toEqual({ caption: "x", action: "list", limit: "10" });
  });

  test("a schema that declares nothing required only needs an object", () => {
    expect(repairableInput('{"a":1}', { type: "object" })).toEqual({ a: 1 });
    expect(repairableInput("[1,2]", { type: "object" })).toBeNull();
  });
});

describe("llmRepairToolCall", () => {
  test("refuses an empty input without reaching a model", async () => {
    resolveModel.mockClear();
    expect(await attempt("")).toBeNull();
    expect(await attempt("{}")).toBeNull();
    expect(resolveModel).not.toHaveBeenCalled();
  });

  test("refuses a call missing a required key without reaching a model", async () => {
    resolveModel.mockClear();
    expect(await attempt('{"caption":"Listing","pageId":"p1"}')).toBeNull();
    expect(resolveModel).not.toHaveBeenCalled();
  });

  test("a wrong tool name is never repaired", async () => {
    resolveModel.mockClear();
    expect(await attempt('{"action":"list"}', invalidNoSuch())).toBeNull();
    expect(resolveModel).not.toHaveBeenCalled();
  });

  test("a complete call with a wrong shape reaches the model", async () => {
    resolveModel.mockClear();
    // The stubbed resolver throws, so the repair degrades to null — the
    // assertion is that the model was asked at all.
    expect(
      await attempt('{"caption":"x","action":"list","limit":"10"}'),
    ).toBeNull();
    expect(resolveModel).toHaveBeenCalledTimes(1);
  });
});
