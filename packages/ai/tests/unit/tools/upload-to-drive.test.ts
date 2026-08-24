import { describe, expect, test } from "bun:test";
import { resolveUploadSource } from "../../../src/tools/upload-to-drive";

/**
 * `uploadToDrive` takes ONE `file` param covering two sources, and this
 * resolution is what decides which service runs — an attachment goes through
 * `promoteChatFilesToDrive` (which carries its own idempotence on the
 * `ai_chat_files.documentId` column), a workspace file through
 * `promoteSandboxFileToDrive` (which has no row to lean on).
 *
 * Picking the wrong branch is silent and expensive: promoting an attachment as
 * a workspace path copies the bytes but leaves the chat-file row unlinked, so
 * the next promotion of the same file duplicates it in the Drive instead of
 * returning the existing document. Hence a test on the rule itself rather than
 * on the tool's I/O.
 */
describe("uploadToDrive — which source a `file` names", () => {
  test("a bare filename is one of the user's attachments", () => {
    expect(resolveUploadSource("rapport.pdf")).toEqual({
      kind: "attachment",
      name: "rapport.pdf",
    });
  });

  test("a path is a file the agent produced", () => {
    expect(resolveUploadSource("outputs/rapport.pdf")).toEqual({
      kind: "workspace",
      path: "outputs/rapport.pdf",
    });
  });

  test("`attachments/x` and a bare `x` are the same file", () => {
    // The prefixed form is what `read` accepts, so the model will write it.
    // Sending it down the workspace branch would lose the chat-file linkage.
    expect(resolveUploadSource("attachments/rapport.pdf")).toEqual(
      resolveUploadSource("rapport.pdf"),
    );
  });

  test("a nested workspace path stays whole", () => {
    expect(resolveUploadSource("outputs/results/chart.png")).toEqual({
      kind: "workspace",
      path: "outputs/results/chart.png",
    });
  });

  test("a filename containing a dot but no slash is still an attachment", () => {
    expect(resolveUploadSource("v1.2 budget.xlsx").kind).toBe("attachment");
  });
});
