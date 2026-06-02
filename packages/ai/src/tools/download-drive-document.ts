import db from "@fretik/shared/db";
import {
  buildDocumentOriginalKey,
  getDocumentSidecarBytes,
} from "@fretik/shared/lib/document-storage";
import { getObjectBytes } from "@fretik/shared/lib/s3";
import { tool } from "ai";
import { extname } from "path";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  listFiles,
  WORKSPACE_DIRS,
  writeFile,
} from "../lib/conversation-storage";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * `download_drive_document` tool — pull a Drive document's binary
 * bytes into the conversation sandbox so `python` / `bash` /
 * `vision` / `read` can operate on the original file.
 *
 * Lazy on-demand by design. The Fretik Drive can hold thousands of
 * documents per team; we never mount the whole tree. Instead, the
 * agent first locates the document (via `searchKnowledge` for
 * content questions, `listDocuments` / `querySql` for metadata) and
 * then calls this tool with the chosen `documentId`. The bytes land
 * at
 *
 *   /workspace/drive/{documentId}-{originalFilename}
 *
 * inside the sandbox. From there:
 *   - `read('drive/...')` works for text-like files (CSV / JSON / TXT)
 *   - `vision` works for images / PDFs
 *   - `python` can `pandas.read_excel('drive/...')`,
 *     `PyPDF2.PdfReader('drive/...')`, etc.
 *
 * Guard rails:
 *   - **ACL**: the document's `team_id` must match the caller's
 *     conversation team. Cross-team access returns a typed error.
 *   - **Quota**: total bytes under `/workspace/drive/` capped at 100
 *     MB per conversation. Adjust if needed; intentionally tight to
 *     avoid sandbox tmpfs pressure (`/workspace` lives in 256 MiB).
 *   - **One document per call**: no bulk mode — keeps cost
 *     attributable and forces the agent to triage what it actually
 *     needs.
 *   - **No S3 backup**: `drive/` is NOT mirrored to the chatbot
 *     session S3 prefix (the original is already durable in the
 *     documents bucket; re-downloading is cheap). On sandbox expiry
 *     the agent simply re-downloads what it needs.
 *
 * Always prefer `searchKnowledge` (RAG) for content questions — it
 * returns extracted chunks at near-zero cost. Only fall back to
 * `download_drive_document` when you need the binary (vision on a
 * scan, generation from a template, parsing with a Python lib).
 */

const DRIVE_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Restrict filename to a safe character set so a rogue document
 * filename can't escape the sandbox via `..` or path separators.
 * Mirrors the rule used by `sanitizeSessionPath` per-segment.
 */
const sanitizeFilename = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]/g, "_");

const buildDrivePath = (documentId: string, filename: string): string =>
  `${WORKSPACE_DIRS.drive}/${documentId}-${sanitizeFilename(filename)}`;

/**
 * Sidecar lives at the same prefix as the binary but with a `.md`
 * extension swapped in — keeps `read('drive/{id}-{name}.pdf')` and
 * `read('drive/{id}-{name}.md')` symmetrical so the extension-routing
 * in `read.ts` resolves a binary path to its sidecar transparently.
 */
const buildDriveSidecarPath = (binarySandboxPath: string): string => {
  const ext = extname(binarySandboxPath);
  const base = ext
    ? binarySandboxPath.slice(0, -ext.length)
    : binarySandboxPath;
  return `${base}.md`;
};

export const createDownloadDriveDocumentTool = () =>
  tool({
    description: [
      "Download a Drive document's binary bytes into the conversation sandbox so `read` / `vision` / `python` / `bash` can operate on the original file. For OCR-eligible documents (PDF / DOCX / PPTX / images) the pre-computed markdown sidecar is also pulled alongside the binary; `read('drive/{uuid}-{name}.pdf')` then auto-resolves to that `.md` sidecar via extension routing.",
      "",
      "When to use:",
      "- The user asks you to render a chart / generate a derived file (Excel / Word / PDF) FROM an existing Drive document.",
      "- You need to ask `vision` about a Drive image / scan / PDF for layout / signatures / diagrams.",
      "- You need a Python parser (pandas, openpyxl) on a binary Drive document (e.g. xlsx — no sidecar exists for those).",
      "- You need the full OCR'd text of a PDF / DOCX / PPTX / image at once (sidecar pre-resolved — cheaper than re-running `pdfplumber`).",
      "",
      "When NOT to use:",
      '- For targeted content questions ("what does the contract say about X"), `searchKnowledge` is still cheaper — RAG returns just the relevant chunks with citations.',
      '- For metadata questions ("how many invoices were uploaded last week"), `listDocuments` / `querySql` are cheaper.',
      "",
      "Inputs:",
      "- documentId (required): UUID of the document. Get it from `listDocuments`, `querySql`, or `searchKnowledge` results.",
      "",
      "Output: { path, absolutePath, filename, mimeType, size, sidecarPath?, sidecarAbsolutePath? }. The `path` is workspace-relative (e.g. `drive/{uuid}-invoice.pdf`) — pass it directly to `read` / `vision` / `python`. When `sidecarPath` is present, you can also `read(sidecarPath)` to get the OCR markdown directly.",
      "",
      "Constraints:",
      "- ACL: only documents in the caller's team are accessible. Cross-team requests return `FORBIDDEN`.",
      "- Quota: 100 MB cumulative under `drive/` per conversation (binary + sidecar both counted). `QUOTA_EXCEEDED` once full.",
      "- One document per call; no bulk download.",
    ].join("\n"),
    inputSchema: z.object({
      documentId: z
        .string()
        .uuid()
        .describe(
          "UUID of the Drive document to download. Source it from `listDocuments`, `querySql` (documents table), or `searchKnowledge` results.",
        ),
    }),
    execute: async ({ documentId }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "download_drive_document is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      // 1. Lookup + ACL check.
      const document = await db.query.documents.findFirst({
        where: { id: documentId },
        columns: {
          id: true,
          teamId: true,
          status: true,
          originalFilename: true,
          fileSize: true,
          mimeType: true,
        },
      });
      if (!document) {
        return {
          error: `Document not found: ${documentId}`,
          code: TOOL_ERROR_CODES.NOT_FOUND,
        };
      }
      if (document.teamId !== ctx.teamId) {
        return {
          error:
            "This document belongs to a different team. You don't have access to it.",
          code: TOOL_ERROR_CODES.FORBIDDEN,
        };
      }
      if (document.status !== "ready") {
        return {
          error: `Document is not ready yet (status=${document.status}). Try again once processing finishes.`,
          code: TOOL_ERROR_CODES.NOT_READY,
        };
      }

      const sandboxPath = buildDrivePath(
        document.id,
        document.originalFilename,
      );
      const sidecarSandboxPath = buildDriveSidecarPath(sandboxPath);

      // 2. Idempotent: skip the download if the file is already in
      //    the sandbox. Common case: the agent calls this twice in
      //    the same turn (e.g. once via vision, then python).
      if (await fileExists(conversationId, sandboxPath)) {
        const sidecarPresent = await fileExists(
          conversationId,
          sidecarSandboxPath,
        );
        return {
          path: sandboxPath,
          absolutePath: `/workspace/${sandboxPath}`,
          filename: document.originalFilename,
          mimeType: document.mimeType,
          size: document.fileSize,
          alreadyPresent: true,
          ...(sidecarPresent
            ? {
                sidecarPath: sidecarSandboxPath,
                sidecarAbsolutePath: `/workspace/${sidecarSandboxPath}`,
              }
            : {}),
        };
      }

      // 3. Quota check before we spend bandwidth fetching from S3.
      //    Sum the sizes of every file already in `drive/` plus the
      //    incoming document's size; reject if the total would
      //    exceed `DRIVE_QUOTA_BYTES`. The sidecar (when present) is
      //    tiny — its size is checked again after we've fetched it.
      let usedBytes = 0;
      try {
        const driveFiles = await listFiles(
          conversationId,
          WORKSPACE_DIRS.drive,
        );
        usedBytes = driveFiles.reduce((acc, entry) => acc + entry.size, 0);
      } catch (err) {
        console.warn(
          "[download-drive-document] drive listFiles failed (assuming 0 used):",
          err instanceof Error ? err.message : err,
        );
      }
      if (usedBytes + document.fileSize > DRIVE_QUOTA_BYTES) {
        const usedMb = (usedBytes / (1024 * 1024)).toFixed(1);
        const docMb = (document.fileSize / (1024 * 1024)).toFixed(1);
        const quotaMb = (DRIVE_QUOTA_BYTES / (1024 * 1024)).toFixed(0);
        return {
          error: `Drive quota exceeded for this conversation: ${usedMb} MB already downloaded, this document adds ${docMb} MB, cap is ${quotaMb} MB. Delete files under drive/ via bash (\`rm drive/...\`) or work with what you already have.`,
          code: TOOL_ERROR_CODES.QUOTA_EXCEEDED,
          usedBytes,
          quotaBytes: DRIVE_QUOTA_BYTES,
        };
      }

      // 4. Stream binary + sidecar in parallel from S3. The façade
      //    does NOT backup `drive/` to the chatbot session S3
      //    (re-download on demand is cheaper than mirroring). The
      //    sidecar is optional — spreadsheets and any document that
      //    failed to OCR won't have one.
      const binaryKey = buildDocumentOriginalKey(
        document.id,
        document.originalFilename,
      );
      let bytes: Uint8Array | null;
      let sidecarBytes: Uint8Array | null;
      try {
        [bytes, sidecarBytes] = await Promise.all([
          getObjectBytes(binaryKey),
          getDocumentSidecarBytes(document.id),
        ]);
      } catch (err) {
        return {
          error: `Failed to fetch document bytes from storage: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.S3_FETCH_FAILED,
        };
      }
      if (!bytes) {
        return {
          error: `Document bytes not found in storage (key=${binaryKey}).`,
          code: TOOL_ERROR_CODES.S3_OBJECT_MISSING,
        };
      }

      // Re-check the quota now that we know the sidecar's actual size.
      // Sidecars are typically <200 KB so this rarely matters, but we'd
      // rather refuse than blow past the cap in an edge case.
      const sidecarSize = sidecarBytes?.byteLength ?? 0;
      if (usedBytes + document.fileSize + sidecarSize > DRIVE_QUOTA_BYTES) {
        const usedMb = (usedBytes / (1024 * 1024)).toFixed(1);
        const totalMb = (
          (document.fileSize + sidecarSize) /
          (1024 * 1024)
        ).toFixed(1);
        const quotaMb = (DRIVE_QUOTA_BYTES / (1024 * 1024)).toFixed(0);
        return {
          error: `Drive quota exceeded for this conversation: ${usedMb} MB already downloaded, this document (+ sidecar) adds ${totalMb} MB, cap is ${quotaMb} MB. Delete files under drive/ via bash or work with what you already have.`,
          code: TOOL_ERROR_CODES.QUOTA_EXCEEDED,
          usedBytes,
          quotaBytes: DRIVE_QUOTA_BYTES,
        };
      }

      try {
        await writeFile(conversationId, sandboxPath, bytes);
        if (sidecarBytes) {
          await writeFile(conversationId, sidecarSandboxPath, sidecarBytes);
        }
      } catch (err) {
        return {
          error: `Failed to write document into the conversation sandbox: ${err instanceof Error ? err.message : String(err)}`,
          code: TOOL_ERROR_CODES.SANDBOX_WRITE_FAILED,
        };
      }

      return {
        path: sandboxPath,
        absolutePath: `/workspace/${sandboxPath}`,
        filename: document.originalFilename,
        mimeType: document.mimeType,
        size: document.fileSize,
        ...(sidecarBytes
          ? {
              sidecarPath: sidecarSandboxPath,
              sidecarAbsolutePath: `/workspace/${sidecarSandboxPath}`,
            }
          : {}),
      };
    },
  });
