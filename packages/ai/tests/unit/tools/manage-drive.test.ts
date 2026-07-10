import { describe, expect, test } from "bun:test";
import { manageDriveInputSchema } from "../../../src/tools/manage-drive";

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
    "moveFolder",
    "deleteFolder",
    "moveDocument",
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
