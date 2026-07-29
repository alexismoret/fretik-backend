import { describe, expect, test } from "bun:test";
import { toAttachmentBasename } from "../../../src/tools/manage-workflow";

// `run_test` speaks two vocabularies at once: `ai_chat_files.filename` and a
// form payload hold basenames, while `<file_attachments>` and every other tool
// hold `attachments/<name>`. Normalising only ONE side is what cost a wasted
// round-trip twice — first on `files` (2026-07-27), then on the form payload
// (2026-07-28, `Form field 'documents' references files not attached`). Both
// sides now go through this single function.
describe("toAttachmentBasename", () => {
  test.each([
    ["attachments/invoice.pdf", "invoice.pdf"],
    ["invoice.pdf", "invoice.pdf"],
    ["attachments/a b.PDF", "a b.PDF"],
    // Only the workspace prefix is stripped — a name that merely contains the
    // word keeps every character.
    ["my-attachments/x.pdf", "my-attachments/x.pdf"],
    ["attachments/nested/x.pdf", "nested/x.pdf"],
  ])("%s → %s", (input, expected) => {
    expect(toAttachmentBasename(input)).toBe(expected);
  });
});
