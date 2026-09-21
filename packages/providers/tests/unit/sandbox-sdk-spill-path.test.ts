import { describe, expect, test } from "bun:test";

/**
 * Where a provider's downloaded bytes land in the sandbox.
 *
 * This is a three-language contract for ONE path: `_DOWNLOAD_SPILL_DIR`
 * here, `WORKSPACE_DIRS.downloads` in `@fretik/ai/lib/conversation-storage`,
 * and `DOWNLOAD_PREFIX` in `@fretik/shared/services/chat-files/workspace-files`.
 * Nothing but agreement makes them one path, so the one that can be
 * asserted from TypeScript is asserted.
 *
 * It used to be `/workspace/attachments`, and that cost more than a wrong
 * label: `read` resolves anything under `attachments/` through the
 * `ai_chat_files` table, so every file a provider downloaded came back as
 * `File not found` — pointing the agent at a `<file_attachments>` block the
 * file had never been listed in. Measured in production on conversation
 * `01a0aac8-…`: six `download_file` calls, zero bytes read.
 *
 * Reading the COMMITTED asset rather than the template, because the asset is
 * what ships to the sandbox — a template edited without `bun run gen:sdk`
 * changes nothing the agent runs.
 */

const RUNTIME_PATH = new URL(
  "../../../ai/sandbox-assets/fretik_apps/_runtime.py",
  import.meta.url,
);

const runtime = await Bun.file(RUNTIME_PATH).text();

describe("sandbox SDK spill path", () => {
  test("downloads land under /workspace/downloads", () => {
    expect(runtime).toContain('_DOWNLOAD_SPILL_DIR = "/workspace/downloads"');
  });

  test("nothing in the shipped runtime writes to attachments/", () => {
    // `attachments/` means "the user gave me this file". The SDK is never in
    // a position to say that, so the string has no business being here at
    // all — including in a comment that a later edit might follow.
    expect(runtime).not.toContain("/workspace/attachments");
  });

  test("both spill helpers use the same constant", () => {
    // A base64 spill (Outlook, IMAP) and a URL spill (SharePoint, Teams)
    // are different code paths that must not drift to different directories.
    const uses = runtime.match(/_DOWNLOAD_SPILL_DIR/g) ?? [];
    // One definition + two `os.makedirs` + two `os.path.join`.
    expect(uses.length).toBe(5);
  });
});
