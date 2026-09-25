import { describe, expect, test } from "bun:test";
import {
  MAX_LINKS_PER_CALL,
  manageLinkInputSchema,
  requestedEdges,
} from "../../../src/tools/manage-link";

/**
 * `manageLink` takes a list of edges and still takes the single-edge shape
 * every call in an older history carries. Per-action required fields are
 * checked in `execute` (a recoverable `toolError`), never by the schema.
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

describe("requestedEdges", () => {
  test("the top-level pair is one more edge, after the list", () => {
    expect(
      requestedEdges({
        action: "link",
        links: [{ fromRecordId: "a", toRecordId: "b" }],
        fromRecordId: "c",
        toDocumentId: "d",
      }),
    ).toEqual([
      { fromRecordId: "a", toRecordId: "b" },
      {
        fromRecordId: "c",
        fromDocumentId: undefined,
        toRecordId: undefined,
        toDocumentId: "d",
      },
    ]);
  });

  test("no top-level end adds nothing", () => {
    expect(requestedEdges({ action: "link" })).toEqual([]);
  });
});
