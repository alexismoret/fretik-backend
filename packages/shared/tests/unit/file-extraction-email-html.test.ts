import { describe, expect, test } from "bun:test";
import { extractEmailToMarkdown } from "../../src/services/file-extraction/email";
import { convertHtmlToMarkdown } from "../../src/services/file-extraction/html";

/**
 * Contract for the two extraction routes added with the file-type
 * registry. Both turn a format the agent could not read before into
 * markdown, WITHOUT replacing the original: an HTML document is still
 * served raw to the agent, and a mail's attachments are listed rather
 * than unpacked (the sandbox does that on demand).
 */

const EML = [
  "From: Alice Martin <alice@acme.com>",
  "To: Bob <bob@corp.fr>",
  "Subject: Quarterly quote",
  "Date: Mon, 12 Aug 2026 09:15:00 +0200",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="XX"',
  "",
  "--XX",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello, the quote is attached.",
  "--XX",
  'Content-Type: application/pdf; name="quote.pdf"',
  'Content-Disposition: attachment; filename="quote.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "--XX--",
  "",
].join("\n");

describe("convertHtmlToMarkdown", () => {
  test("keeps structure: headings, tables, lists, links", () => {
    const markdown = convertHtmlToMarkdown(
      "<h1>Title</h1><p>Hello <b>world</b></p>" +
        "<table><tr><th>A</th></tr><tr><td>1</td></tr></table>" +
        "<ul><li>one</li></ul><a href='https://example.com'>link</a>",
    );
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("**world**");
    expect(markdown).toContain("| A |");
    expect(markdown).toContain("- one");
    expect(markdown).toContain("[link](https://example.com)");
  });

  test("scripts and styles never reach the markdown", () => {
    const markdown = convertHtmlToMarkdown(
      "<style>b{color:red}</style><script>alert(1)</script><p>safe</p>",
    );
    expect(markdown).toBe("safe");
  });
});

describe("extractEmailToMarkdown", () => {
  test("an .eml yields its headers, body and attachment list", async () => {
    const mail = await extractEmailToMarkdown(
      new TextEncoder().encode(EML),
      "message/rfc822",
    );
    expect(mail.markdown).toContain("Alice Martin <alice@acme.com>");
    expect(mail.markdown).toContain("Bob <bob@corp.fr>");
    expect(mail.markdown).toContain("Quarterly quote");
    expect(mail.markdown).toContain("Hello, the quote is attached.");
    expect(mail.markdown).toContain("## Attachments");
    expect(mail.markdown).toContain("`quote.pdf`");
  });

  test("attachments are listed as metadata, never inlined", async () => {
    const mail = await extractEmailToMarkdown(
      new TextEncoder().encode(EML),
      "message/rfc822",
    );
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0]?.filename).toBe("quote.pdf");
    expect(mail.attachments[0]?.mimeType).toBe("application/pdf");
    // The PDF bytes must NOT appear in the markdown — only its name.
    expect(mail.markdown).not.toContain("JVBERi0xLjQK");
  });

  test("sub-kilobyte attachments report bytes, not a rounded-up KB", async () => {
    const mail = await extractEmailToMarkdown(
      new TextEncoder().encode(EML),
      "message/rfc822",
    );
    expect(mail.markdown).toContain(" B");
    expect(mail.markdown).not.toContain("1 KB");
  });
});
