import { describe, expect, test } from "bun:test";
import {
  batchTargets,
  manageDriveInputSchema,
  MAX_DOCUMENTS_PER_CALL,
  MAX_FOLDERS_PER_CALL,
} from "../../../src/tools/manage-drive";

/**
 * The never-throw contract for `manageDrive`. Per-action required fields are
 * validated inside `execute` (which returns a recoverable `toolError`), NOT at
 * the schema layer — so an action-only call must PASS the schema and reach
 * `execute` rather than die as an SDK-level input rejection. This mirrors
 * `manageRecord`'s schema test.
 */

describe("manageDrive input schema — per-action validation is deferred to execute", () => {
  test.each([
    "createFolder",
    "renameFolder",
    "describeFolder",
    "moveFolder",
    "deleteFolder",
    "moveDocument",
    "renameDocument",
  ])(
    "accepts action-only input for %s (reaches execute → toolError)",
    (action) => {
      expect(manageDriveInputSchema.safeParse({ action }).success).toBe(true);
    },
  );

  test("accepts a well-formed createFolder", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "createFolder",
        name: "Reports",
      }).success,
    ).toBe(true);
  });

  test("accepts a null parentFolderId (move to root)", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveDocument",
        documentId: "018f0000-0000-7000-8000-000000000000",
        parentFolderId: null,
      }).success,
    ).toBe(true);
  });

  test("accepts an empty description, which clears it", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "describeFolder",
        folderId: "018f0000-0000-7000-8000-000000000000",
        description: "",
      }).success,
    ).toBe(true);
  });

  test("rejects a description longer than the filer reads", () => {
    // The filer clips at the same length; past it, the extra words would
    // be read by the team and ignored by the decision.
    expect(
      manageDriveInputSchema.safeParse({
        action: "describeFolder",
        folderId: "018f0000-0000-7000-8000-000000000000",
        description: "x".repeat(221),
      }).success,
    ).toBe(false);
  });

  test("rejects an unknown action", () => {
    expect(
      manageDriveInputSchema.safeParse({ action: "wipeDrive" }).success,
    ).toBe(false);
  });

  test("rejects a non-uuid folderId", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "renameFolder",
        folderId: "not-a-uuid",
        name: "x",
      }).success,
    ).toBe(false);
  });
});

const uuid = (n: number): string =>
  `018f0000-0000-7000-8000-${n.toString().padStart(12, "0")}`;

describe("manageDrive batch inputs", () => {
  test("accepts a list of documents bound for one folder", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveDocument",
        documentIds: [uuid(1), uuid(2), uuid(3)],
        parentFolderId: uuid(9),
      }).success,
    ).toBe(true);
  });

  test("still accepts the singular documentId an older history carries", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveDocument",
        documentId: uuid(1),
        parentFolderId: null,
      }).success,
    ).toBe(true);
  });

  test(`caps a document list at ${MAX_DOCUMENTS_PER_CALL.toString()}`, () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, i) => uuid(i));
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveDocument",
        documentIds: ids(MAX_DOCUMENTS_PER_CALL),
      }).success,
    ).toBe(true);
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveDocument",
        documentIds: ids(MAX_DOCUMENTS_PER_CALL + 1),
      }).success,
    ).toBe(false);
  });

  test(`caps a folder list at ${MAX_FOLDERS_PER_CALL.toString()}`, () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "deleteFolder",
        folderIds: Array.from({ length: MAX_FOLDERS_PER_CALL + 1 }, (_, i) =>
          uuid(i),
        ),
      }).success,
    ).toBe(false);
  });

  test("rejects a non-uuid inside a list", () => {
    expect(
      manageDriveInputSchema.safeParse({
        action: "moveFolder",
        folderIds: [uuid(1), "not-a-uuid"],
      }).success,
    ).toBe(false);
  });
});

describe("batchTargets", () => {
  test("merges a stray singular id into the list, once", () => {
    expect(batchTargets(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    expect(batchTargets(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  test("deduplicates, keeping the order the model gave", () => {
    expect(batchTargets(["b", "a", "b"], undefined)).toEqual(["b", "a"]);
  });

  test("a singular id alone is a list of one", () => {
    expect(batchTargets(undefined, "a")).toEqual(["a"]);
  });

  test("nothing given is nothing to do", () => {
    expect(batchTargets(undefined, undefined)).toEqual([]);
  });
});
