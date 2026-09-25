import { resolveAccessMany } from "@fretik/shared/authz/access";
import db from "@fretik/shared/db";
import {
  buildDocumentOriginalKey,
  getDocumentSidecarBytes,
} from "@fretik/shared/lib/document-storage";
import { getObjectBytes } from "@fretik/shared/lib/s3";
import { tool } from "ai";
import { extname } from "path";
import { z } from "zod";
import { actingPrincipal } from "../agents/shared/acting-principal";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  fileExists,
  listFiles,
  WORKSPACE_DIRS,
  writeFile,
} from "../lib/conversation-storage";
import { TOOL_ERROR_CODES } from "../lib/tool-error-codes";

/**
 * `download_drive_document` tool — pull Drive documents' binary
 * bytes into the conversation sandbox so `python` / `bash` /
 * `vision` / `read` can operate on the original files.
 *
 * Lazy on-demand by design. The Fretik Drive can hold thousands of
 * documents per team; we never mount the whole tree. Instead, the
 * agent first locates the documents (via `searchKnowledge` for
 * content questions, `listDocuments` / `querySql` for metadata) and
 * then calls this tool with the chosen ids. The bytes land at
 *
 *   /workspace/drive/{documentId}-{originalFilename}
 *
 * inside the sandbox. From there:
 *   - `read('drive/...')` works for text-like files (CSV / JSON / TXT)
 *   - `vision` works for images / PDFs
 *   - `python` can `pandas.read_excel('drive/...')`,
 *     `PyPDF2.PdfReader('drive/...')`, etc.
 *
 * **Takes a LIST.** Comparing twelve invoices used to be twelve tool
 * calls whose only difference was a UUID — twelve round-trips through
 * the model for work it had already decided on. The quota is what
 * bounds the cost, not the call count, and it is enforced across the
 * batch exactly as it was across successive calls.
 *
 * Guard rails:
 *   - **ACL**: each document's `team_id` must match the caller's
 *     conversation team. Cross-team ids are refused per document.
 *   - **Quota**: total bytes under `/workspace/drive/` capped at 100
 *     MB per conversation. Adjust if needed; intentionally tight to
 *     avoid sandbox tmpfs pressure (`/workspace` lives in 256 MiB).
 *   - **Per-document results**: a batch reports each id's outcome; one
 *     unprocessed document does not cost the other eleven.
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
 * Documents one call may fetch. The quota is the real ceiling; this one
 * keeps a single call from spending a minute in S3 before the agent sees
 * anything.
 */
const MAX_DOCUMENTS = 20;

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
      'NOT for content questions — "what does this document say about X" is `searchKnowledge`\'s job (cheaper, cited, and it searches inside a KNOWN document via `filters.sourceIds`). Download exists for byte-level work on the original file.',
      "",
      "Downloads Drive documents' binaries into the conversation sandbox so `read` / `vision` / `python` / `bash` can operate on the originals. Takes a LIST — fetch everything you need in one call. For OCR-eligible documents (PDF / DOCX / PPTX / images) the pre-computed markdown sidecar is pulled alongside; `read('drive/{uuid}-{name}.pdf')` then auto-resolves to that `.md` sidecar via extension routing.",
      "",
      "When to use:",
      "- Generate a derived file (Excel / Word / PDF / chart) FROM an existing Drive document, or reuse one as a template.",
      "- Ask `vision` about a Drive image / scan / PDF (layout, signatures, diagrams).",
      "- Run a Python parser (pandas, openpyxl, pypdf) on a binary Drive document (e.g. xlsx — no sidecar exists for those).",
      "- Feed a document's FULL text through a processing script (the sidecar is pre-resolved — cheaper than re-running OCR); for answering a question about that text, `searchKnowledge` remains the move.",
      "",
      "Inputs:",
      `- documentIds (required): UUIDs of the documents. Get them from \`listDocuments\`, \`querySql\`, or \`searchKnowledge\` results. Pass every document you need in ONE call — max ${MAX_DOCUMENTS.toString()}.`,
      "",
      "Output: { ok, files: [{ documentId, path, absolutePath, filename, mimeType, size, alreadyPresent?, sidecarPath?, sidecarAbsolutePath? }], failed: [{ documentId, error, code }] }. Each `path` is workspace-relative (e.g. `drive/{uuid}-invoice.pdf`) — pass it directly to `read` / `vision` / `python`. When `sidecarPath` is present, you can also `read(sidecarPath)` to get the OCR markdown directly.",
      "",
      "Constraints:",
      "- ACL: only documents in the caller's team are accessible. A cross-team id lands in `failed` with `FORBIDDEN`.",
      "- Quota: 100 MB cumulative under `drive/` per conversation (binary + sidecar both counted), spent in the order you listed the ids. Documents past the cap land in `failed` with `QUOTA_EXCEEDED` — put the ones you need most first.",
      "- A batch can half-succeed: read `failed` before assuming every file is there.",
    ].join("\n"),
    inputSchema: z.object({
      documentIds: z
        .array(z.string().uuid())
        .min(1)
        .max(MAX_DOCUMENTS)
        .describe(
          "UUIDs of the Drive documents to download. Source them from `listDocuments`, `querySql` (documents table), or `searchKnowledge` results.",
        ),
    }),
    execute: async ({ documentIds }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return {
          error:
            "download_drive_document is only available inside a conversation. No conversationId in the current context.",
          code: TOOL_ERROR_CODES.NO_CONVERSATION,
        };
      }
      const conversationId = ctx.conversationId;

      // The same id twice would pay for the same bytes twice against a
      // quota that is the whole point of the ceiling.
      const requested = [...new Set(documentIds)];

      // Measure what `drive/` already holds ONCE for the whole batch, then
      // account each download against the running total. Re-listing per
      // document would be N listings to learn something this loop already
      // knows.
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

      const files: Record<string, unknown>[] = [];
      const failed: Record<string, unknown>[] = [];

      // What the person the turn acts for can open — restricted files and
      // folders included, and files shared with them from another team.
      const visible = await resolveAccessMany(
        await actingPrincipal(ctx),
        "document",
        requested,
      );

      for (const documentId of requested) {
        const outcome = await downloadOne({
          documentId,
          conversationId,
          visible: visible.has(documentId),
          usedBytes,
          quotaBytes: DRIVE_QUOTA_BYTES,
        });
        if ("error" in outcome) {
          failed.push({ documentId, ...outcome });
          continue;
        }
        usedBytes += outcome.bytesAdded;
        files.push(outcome.file);
      }

      return { ok: failed.length === 0, files, failed };
    },
  });

/**
 * Fetch ONE document into the sandbox, charged against a running byte
 * budget.
 *
 * Split out of `execute` so the batch loop reads as a loop: every guard
 * below (ACL, readiness, quota, storage) is per document, and a failing one
 * costs that id a row in `failed` rather than the whole call.
 */
const downloadOne = async (params: {
  documentId: string;
  conversationId: string;
  /** Whether the person the turn acts for can open it (the engine's answer). */
  visible: boolean;
  usedBytes: number;
  quotaBytes: number;
}): Promise<
  | { file: Record<string, unknown>; bytesAdded: number }
  | { error: string; code: string; usedBytes?: number; quotaBytes?: number }
> => {
  const { documentId, conversationId, usedBytes, quotaBytes } = params;

  // 1. Lookup + ACL check.
  const document = await db.query.documents.findFirst({
    where: { id: documentId },
    columns: {
      id: true,
      status: true,
      originalFilename: true,
      fileSize: true,
      mimeType: true,
    },
  });
  // One the person cannot open is answered like one that does not exist.
  if (!document || !params.visible) {
    return {
      error: `Document not found: ${documentId}`,
      code: TOOL_ERROR_CODES.NOT_FOUND,
    };
  }
  if (document.status !== "ready") {
    return {
      error: `Document is not ready yet (status=${document.status}). Try again once processing finishes.`,
      code: TOOL_ERROR_CODES.NOT_READY,
    };
  }

  const sandboxPath = buildDrivePath(document.id, document.originalFilename);
  const sidecarSandboxPath = buildDriveSidecarPath(sandboxPath);

  // 2. Idempotent: skip the download if the file is already in
  //    the sandbox. Common case: the agent calls this twice in
  //    the same turn (e.g. once via vision, then python).
  if (await fileExists(conversationId, sandboxPath)) {
    const sidecarPresent = await fileExists(conversationId, sidecarSandboxPath);
    return {
      // Already counted in `usedBytes` by the listing above — charging it
      // again would spend the quota twice for one file.
      bytesAdded: 0,
      file: {
        documentId: document.id,
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
      },
    };
  }

  const quotaError = (added: number, label: string) => {
    const usedMb = (usedBytes / (1024 * 1024)).toFixed(1);
    const addMb = (added / (1024 * 1024)).toFixed(1);
    const quotaMb = (quotaBytes / (1024 * 1024)).toFixed(0);
    return {
      error: `Drive quota exceeded for this conversation: ${usedMb} MB already downloaded, ${label} adds ${addMb} MB, cap is ${quotaMb} MB. Delete files under drive/ via bash (\`rm drive/...\`) or work with what you already have.`,
      code: TOOL_ERROR_CODES.QUOTA_EXCEEDED,
      usedBytes,
      quotaBytes,
    };
  };

  // 3. Quota check before we spend bandwidth fetching from S3.
  if (usedBytes + document.fileSize > quotaBytes) {
    return quotaError(document.fileSize, "this document");
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
  const totalSize = bytes.byteLength + sidecarSize;
  if (usedBytes + totalSize > quotaBytes) {
    return quotaError(totalSize, "this document (+ sidecar)");
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
    bytesAdded: totalSize,
    file: {
      documentId: document.id,
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
    },
  };
};
