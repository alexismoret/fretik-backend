import { describe, expect, test } from "bun:test";
import { effectiveSearchFilters } from "../../../src/tools/rag-search";

/**
 * What `searchKnowledge` hands `searchRAG`. The folder scope is the one case
 * where the tool rewrites the model's filters, so it is the one worth pinning:
 * a folder search that leaked into memories or skills, or that fell back to
 * the model's own `sourceIds` after they were intersected, would answer from
 * outside the folder it was asked about.
 */
describe("effectiveSearchFilters", () => {
  test("no filters stays no filters", () => {
    expect(effectiveSearchFilters(undefined, [], undefined)).toBeUndefined();
  });

  test("a folder scope searches only its documents", () => {
    expect(
      effectiveSearchFilters({ sourceIds: ["x"] }, ["memories"], ["d1", "d2"]),
    ).toEqual({ sourceIds: ["d1", "d2"], sourceTypes: ["documents"] });
  });

  test("without a folder, the model's filters pass through", () => {
    expect(
      effectiveSearchFilters({ sourceIds: ["x"] }, ["documents"], undefined),
    ).toEqual({ sourceIds: ["x"], sourceTypes: ["documents"] });
    expect(effectiveSearchFilters({}, [], undefined)).toEqual({
      sourceIds: undefined,
      sourceTypes: undefined,
    });
  });
});
