import { InvalidToolInputError, NoSuchToolError } from "ai";
import { describe, expect, test } from "bun:test";
import { isRecoverableToolCallError } from "../../../src/lib/stream-errors";
import {
  manageRecordInputSchema,
  resolveRecordValues,
} from "../../../src/tools/manage-record";

/**
 * The never-fatal contract for `manageRecord`. The eval `tool-error-rate` can
 * NOT see an SDK-layer input rejection (it counts only calls that passed the
 * schema), so this asserts it directly: the weak-model value slips we promise
 * to absorb pass the schema (→ reach `execute`, coercion normalises them), and
 * the residual slips that don't pass are made recoverable — never a fatal
 * stream death — by `isRecoverableToolCallError`.
 */

const create = (value: unknown) => ({
  action: "create",
  typeKey: "client",
  data: [{ key: "field", value }],
});

describe("manageRecord input schema — string-dominant value (lossless)", () => {
  // A single value is a quoted string so it keeps its exact text; a list of
  // strings is for multi-select; null clears. These are the well-formed shapes.
  test.each([
    ["quoted scalar", "Acme"],
    ["quoted number", "1500"],
    ["quoted phone keeps the +", "+33611223344"],
    ["string list (multi-select)", ["emea", "apac"]],
    ["explicit null (clear)", null],
  ])("accepts %s", (_label, value) => {
    expect(manageRecordInputSchema.safeParse(create(value)).success).toBe(true);
  });

  // A bare JSON number/boolean is OUT of the union ON PURPOSE: accepting it
  // would let the model drop the `+` of a phone (33611223344) — a silent wrong
  // write. Rejecting forces a quoted string; the rejection is recoverable (see
  // the guard test below), never fatal, never silent. Objects/numeric arrays
  // are likewise rejected-but-recoverable.
  test.each([
    ["bare number (drops a phone's +)", 33611223344],
    ["bare boolean", true],
    ["object wrap {$text}", { $text: "x" }],
    ["numeric array", [1, 2]],
  ])("rejects %s (recoverable, not silent)", (_label, value) => {
    expect(manageRecordInputSchema.safeParse(create(value)).success).toBe(
      false,
    );
  });

  test("a value under a stray key (`item`) passes the schema (kept, then recovered)", () => {
    // The `{key, item}` slip: `value` is optional + `.catchall` keeps `item`, so
    // the call reaches execute (no SDK rejection); `resolveRecordValues` then
    // recovers the value. No more AI_InvalidToolInputError for this case.
    const parsed = manageRecordInputSchema.safeParse({
      action: "create",
      typeKey: "client",
      data: [{ key: "regions", item: "apac" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("create with no data passes the schema (data is optional at this layer)", () => {
    // `create requires data` is enforced in execute, not the schema — so the
    // call still reaches execute and returns a recoverable {error,code}.
    expect(
      manageRecordInputSchema.safeParse({ action: "create", typeKey: "client" })
        .success,
    ).toBe(true);
  });
});

describe("resolveRecordValues", () => {
  test("maps well-formed { key, value } entries", () => {
    const { values, missing } = resolveRecordValues([
      { key: "name", value: "Acme" },
      { key: "regions", value: ["emea", "apac"] },
    ]);
    expect(values).toEqual({ name: "Acme", regions: ["emea", "apac"] });
    expect(missing).toEqual([]);
  });

  test("recovers a value placed under a stray key (`item` instead of `value`)", () => {
    const { values, missing } = resolveRecordValues([
      { key: "regions", item: "apac" },
    ]);
    expect(values).toEqual({ regions: "apac" });
    expect(missing).toEqual([]);
  });

  test("keeps an explicit null (clears the field)", () => {
    const { values, missing } = resolveRecordValues([
      { key: "phone", value: null },
    ]);
    expect(values).toEqual({ phone: null });
    expect(missing).toEqual([]);
  });

  test("reports an entry with no resolvable value (taught, not dropped)", () => {
    const { values, missing } = resolveRecordValues([{ key: "regions" }]);
    expect(values).toEqual({});
    expect(missing).toEqual(["regions"]);
  });
});

describe("isRecoverableToolCallError", () => {
  test("InvalidToolInputError is recoverable", () => {
    const err = new InvalidToolInputError({
      toolName: "manageRecord",
      toolInput: "{}",
      cause: new Error("bad"),
    });
    expect(isRecoverableToolCallError(err)).toBe(true);
  });

  test("NoSuchToolError is recoverable", () => {
    const err = new NoSuchToolError({ toolName: "nope" });
    expect(isRecoverableToolCallError(err)).toBe(true);
  });

  test("matches a re-wrapped error by name/message (outer stream handler)", () => {
    // The outer createUIMessageStream handler receives a copy whose prototype is
    // lost, so isInstance misses it — match by message instead.
    const wrapped = new Error(
      "Invalid input for tool manageRecord: Type validation failed",
    );
    expect(isRecoverableToolCallError(wrapped)).toBe(true);
  });

  test("a generic stream error is NOT treated as a recoverable tool-call error", () => {
    expect(isRecoverableToolCallError(new Error("network reset"))).toBe(false);
    expect(isRecoverableToolCallError("boom")).toBe(false);
  });
});
