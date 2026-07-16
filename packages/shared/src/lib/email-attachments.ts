import { readSessionFile } from "./chatbot-session-storage";

/**
 * Hard cap on the total raw byte size of session files we are willing
 * to attach to a notification email. Scaleway TEM caps the entire
 * request payload at 25 MB *including* base64 expansion (≈1.37×) and
 * the JSON envelope; Gmail/Outlook bounce anything larger downstream
 * of Scaleway anyway. 20 MB raw → ≈27 MB encoded which leaves us
 * comfortable headroom in both directions.
 */
export const MAX_ATTACHMENT_BYTES_TOTAL = 20 * 1024 * 1024;

/**
 * Tighten a filename so it can ride safely in an email header. The
 * `presentFiles` tool already sanitises path segments, but a defence
 * in depth here keeps unrelated upstream changes (e.g. an admin tool
 * uploading something raw) from leaking weird characters into MIME
 * headers and breaking the message.
 */
export const sanitizeAttachmentFilename = (filename: string): string => {
  const base = filename.split("/").pop() ?? filename;
  const trimmed = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return trimmed.length > 0 ? trimmed : "attachment";
};

/** A produced file to attach, addressed inside a conversation's S3
 * session mirror. `size` is the reported byte size when known —
 * chatbot `presentFiles` outputs always carry it, workflow run outputs
 * may not. */
export interface EmailAttachmentFile {
  path: string;
  filename: string;
  mimeType: string;
  size?: number;
}

export interface BuiltEmailAttachment {
  name: string;
  type: string;
  /** base64-encoded content — what Scaleway expects on the wire. */
  content: string;
}

/**
 * Download the listed files from the conversation's S3 session mirror
 * and return the encoded attachments, plus a flag telling the email
 * generator to render the "files too large" notice instead.
 *
 * All-or-nothing budget: exceeding `MAX_ATTACHMENT_BYTES_TOTAL` drops
 * EVERY attachment (a partial set would silently misrepresent the
 * result). Reported sizes are pre-checked before any download;
 * files with unknown/underreported sizes are caught by counting the
 * actually downloaded bytes. Raw bytes are what's budgeted — the cap
 * already accounts for the base64 blowup.
 */
export const buildSessionFileAttachments = async (params: {
  conversationId: string;
  files: EmailAttachmentFile[];
  logPrefix: string;
}): Promise<{ attachments: BuiltEmailAttachment[]; oversized: boolean }> => {
  const { conversationId, files, logPrefix } = params;
  if (files.length === 0) return { attachments: [], oversized: false };

  let reportedTotal = 0;
  for (const file of files) {
    reportedTotal += file.size ?? 0;
    if (reportedTotal > MAX_ATTACHMENT_BYTES_TOTAL) {
      console.info(
        `${logPrefix} email attachments: total (${reportedTotal.toString()}B reported) exceeds ${MAX_ATTACHMENT_BYTES_TOTAL.toString()}B cap — skipping attachments`,
      );
      return { attachments: [], oversized: true };
    }
  }

  const attachments: BuiltEmailAttachment[] = [];
  let downloadedTotal = 0;
  for (const file of files) {
    const bytes = await readSessionFile(conversationId, file.path);
    if (!bytes) {
      console.warn(
        `${logPrefix} email attachments: missing S3 mirror for ${file.path} — skipping`,
      );
      continue;
    }
    downloadedTotal += bytes.byteLength;
    if (downloadedTotal > MAX_ATTACHMENT_BYTES_TOTAL) {
      console.info(
        `${logPrefix} email attachments: total (${downloadedTotal.toString()}B downloaded) exceeds ${MAX_ATTACHMENT_BYTES_TOTAL.toString()}B cap — skipping attachments`,
      );
      return { attachments: [], oversized: true };
    }
    attachments.push({
      name: sanitizeAttachmentFilename(file.filename),
      type: file.mimeType,
      content: Buffer.from(bytes).toString("base64"),
    });
  }
  return { attachments, oversized: false };
};
