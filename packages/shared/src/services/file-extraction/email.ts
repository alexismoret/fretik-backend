import MsgReader from "@kenjiuno/msgreader";
import PostalMime from "postal-mime";
import { convertHtmlToMarkdown } from "./html";

/**
 * E-mail → markdown, for the `email` extraction route (`.eml` and
 * Outlook `.msg`).
 *
 * Attachments are LISTED, never unpacked: recursively extracting a
 * mail's payload would turn one upload into an unbounded tree, and the
 * agent already has a better instrument for it — `python` with
 * `extract_msg` / the `email` module, in the sandbox, on demand. What
 * this produces is the readable part: who wrote to whom, when, about
 * what, and what came attached.
 */

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  sizeBytes: number | null;
}

export interface ExtractedEmail {
  markdown: string;
  attachments: EmailAttachment[];
}

const formatAddress = (
  name?: string | null,
  address?: string | null,
): string => {
  const trimmedName = name?.trim();
  const trimmedAddress = address?.trim();
  if (trimmedName && trimmedAddress)
    return `${trimmedName} <${trimmedAddress}>`;
  return trimmedAddress ?? trimmedName ?? "";
};

const headerTable = (rows: [string, string][]): string => {
  const present = rows.filter(([, value]) => value.length > 0);
  if (present.length === 0) return "";
  return [
    "| Field | Value |",
    "| --- | --- |",
    ...present.map(([label, value]) => `| ${label} | ${value} |`),
  ].join("\n");
};

const attachmentSection = (attachments: EmailAttachment[]): string => {
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment) => {
    const bytes = attachment.sizeBytes;
    const size =
      bytes === null
        ? ""
        : bytes < 1024
          ? ` — ${bytes.toString()} B`
          : ` — ${Math.round(bytes / 1024).toString()} KB`;
    return `- \`${attachment.filename}\` (${attachment.mimeType})${size}`;
  });
  return ["## Attachments", ...lines].join("\n");
};

const assemble = (args: {
  headers: [string, string][];
  body: string;
  attachments: EmailAttachment[];
}): string =>
  [
    headerTable(args.headers),
    args.body.trim(),
    attachmentSection(args.attachments),
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");

/** RFC-822 `.eml`, parsed with a runtime-agnostic MIME parser. */
const extractEml = async (bytes: Uint8Array): Promise<ExtractedEmail> => {
  const mail = await PostalMime.parse(bytes);
  const attachments: EmailAttachment[] = mail.attachments.map((attachment) => ({
    filename: attachment.filename ?? "(unnamed)",
    mimeType: attachment.mimeType,
    sizeBytes:
      typeof attachment.content === "string"
        ? attachment.content.length
        : attachment.content.byteLength,
  }));

  const body = mail.text
    ? mail.text
    : mail.html
      ? convertHtmlToMarkdown(mail.html)
      : "";

  return {
    markdown: assemble({
      headers: [
        ["From", formatAddress(mail.from?.name, mail.from?.address)],
        [
          "To",
          (mail.to ?? [])
            .map((to) => formatAddress(to.name, to.address))
            .join(", "),
        ],
        [
          "Cc",
          (mail.cc ?? [])
            .map((cc) => formatAddress(cc.name, cc.address))
            .join(", "),
        ],
        ["Date", mail.date ?? ""],
        ["Subject", mail.subject ?? ""],
      ],
      body,
      attachments,
    }),
    attachments,
  };
};

/** Outlook `.msg` — a Compound File Binary container, parsed in pure JS. */
const extractMsg = (bytes: Uint8Array): ExtractedEmail => {
  // MsgReader wants a standalone ArrayBuffer; copying also detaches the
  // reader from whatever larger buffer these bytes were a view into.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const data = new MsgReader(owned.buffer).getFileData();

  const attachments: EmailAttachment[] = (data.attachments ?? []).map(
    (attachment) => ({
      filename: attachment.fileName ?? attachment.fileNameShort ?? "(unnamed)",
      mimeType: attachment.attachMimeTag ?? "application/octet-stream",
      sizeBytes: attachment.contentLength ?? null,
    }),
  );

  const body = data.body
    ? data.body
    : data.bodyHtml
      ? convertHtmlToMarkdown(data.bodyHtml)
      : "";

  return {
    markdown: assemble({
      headers: [
        ["From", formatAddress(data.senderName, data.senderEmail)],
        [
          "To",
          (data.recipients ?? [])
            .map((recipient) => formatAddress(recipient.name, recipient.email))
            .join(", "),
        ],
        ["Date", data.messageDeliveryTime ?? ""],
        ["Subject", data.subject ?? ""],
      ],
      body,
      attachments,
    }),
    attachments,
  };
};

export const extractEmailToMarkdown = async (
  bytes: Uint8Array,
  mimeType: string,
): Promise<ExtractedEmail> =>
  mimeType === "application/vnd.ms-outlook"
    ? extractMsg(bytes)
    : await extractEml(bytes);
