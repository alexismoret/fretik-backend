import { describe, expect, test } from "bun:test";
import {
  MAX_LINKS_PER_CALL,
  manageLinkInputSchema,
} from "../../../src/tools/manage-link";

/**
 * `manageLink` takes its edges as a list, one edge included. Per-action
 * required fields are checked in `execute` (a recoverable `toolError`), never
 * by the schema.
 */

const parse = (input: Record<string, unknown>) =>
  manageLinkInputSchema.safeParse(input);

describe("manageLink input schema", () => {
  test.each(["link", "unlink"])(
    "accepts action-only input for %s",
    (action) => {
      expect(parse({ action }).success).toBe(true);
    },
  );

  test("accepts a list of edges over one relation", () => {
    expect(
      parse({
        action: "link",
        relationKey: "works_for",
        links: [
          { fromRecordId: "a", toRecordId: "b" },
          { fromRecordId: "a", toDocumentId: "d" },
        ],
      }).success,
    ).toBe(true);
  });

  test(`caps a list at ${MAX_LINKS_PER_CALL.toString()}`, () => {
    const edges = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        fromRecordId: "a",
        toRecordId: i.toString(),
      }));
    expect(
      parse({ action: "link", links: edges(MAX_LINKS_PER_CALL) }).success,
    ).toBe(true);
    expect(
      parse({ action: "link", links: edges(MAX_LINKS_PER_CALL + 1) }).success,
    ).toBe(false);
    expect(
      parse({
        action: "unlink",
        linkIds: Array.from({ length: MAX_LINKS_PER_CALL + 1 }, String),
      }).success,
    ).toBe(false);
  });
});

describe("the pre-batch single-edge shape", () => {
  test("is stripped, not rejected, so execute answers with the new shape", () => {
    // A call copied from an older conversation must reach `execute` (which
    // returns a recoverable error naming `links`), not die in the SDK.
    const parsed = parse({
      action: "link",
      relationKey: "works_for",
      fromRecordId: "a",
      toRecordId: "b",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ action: "link", relationKey: "works_for" });
  });
});
