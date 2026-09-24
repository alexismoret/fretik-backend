import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import { mimeFromFilename } from "@fretik/shared/file-types";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  buildSessionKey,
  listSessionPaths,
  readSessionFile,
} from "@fretik/shared/lib/chatbot-session-storage";
import {
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { getPresignedUrl } from "@fretik/shared/lib/s3";
import { assertConversationAccess } from "@fretik/shared/services/ai/assert-conversation-access";
import {
  PromoteSandboxFileError,
  promoteSandboxFileToDrive,
} from "@fretik/shared/services/chat-files/promote-sandbox-file-to-drive";
import { promoteChatFilesToDrive } from "@fretik/shared/services/chat-files/promote-to-drive";
import {
  listConversationWorkspaceFiles,
  resolveDriveState,
} from "@fretik/shared/services/chat-files/workspace-files";
import { getSessionFilePreviewSource } from "@fretik/shared/services/documents/preview";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, ne } from "drizzle-orm";
import type { Context } from "hono";
import {
  deleteFile,
  resolveWorkspacePath,
  WORKSPACE_DIRS,
} from "../lib/conversation-storage";
import { uploadChatFile } from "../services/chat-files/upload";

/**
 * Public chat-file routes. Protected by Better Auth
 * (`authMiddleware`) so the Nuxt app can call them with the user's
 * session cookie. Mounted under `/chatbot-files` at the @fretik/ai
 * top level (see `index.ts`).
 *
 * Routes:
 *  - POST /conversation/:id/files       — multipart upload (one file
 *                                         per request), sync response
 *                                         after Mistral OCR finishes.
 *  - DELETE /conversation/:id/files/:filename — remove the sandbox
 *                                         file, S3 mirror, sidecar,
 *                                         and the DB row.
 *  - GET /conversation/:id/files/:filename/download — presigned URL
 *                                         redirect so the frontend
 *                                         can pull the raw bytes
 *                                         without streaming through
 *                                         our container.
 *  - GET /conversation/:id/files          — list all non-errored rows
 *                                         for the conversation so the
 *                                         frontend can render the
 *                                         aggregate count + existing
 *                                         attachments.
 *
 * Phase 2: every file lives in the conversation's E2B sandbox under
 * `/workspace/attachments/{filename}` (mirror in S3 at
 * `chatbot-sessions/{convId}/attachments/{filename}`). The
 * conversation-storage façade owns the dual-write semantics. Tool-
 * generated outputs (presented via `presentFiles`) live under
 * `outputs/...` instead.
 */

const chatFilesRoutes = new OpenAPIHono<HonoLoggedAppType>();
chatFilesRoutes.use("*", authMiddleware);

const sidecarFilename = (filename: string): string => {
  const dotIndex = filename.lastIndexOf(".");
  const base = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  return `${base}.md`;
};

const buildAttachmentPath = (filename: string): string =>
  `${WORKSPACE_DIRS.attachments}/${filename}`;

/**
 * Top-level workspace dirs an explicit `?path=` may address.
 *
 * These are exactly the trees `mirrorSandboxChanges` backs up to S3, so
 * they are the only ones that still have bytes to serve once the sandbox
 * is paused or expired. Mirrors `BACKUP_ELIGIBLE_DIRS` in
 * `lib/conversation-storage.ts` — keep the two in step.
 */
const DOWNLOADABLE_DIRS = new Set<string>([
  WORKSPACE_DIRS.attachments,
  WORKSPACE_DIRS.downloads,
  WORKSPACE_DIRS.outputs,
]);

/**
 * Every route here addresses a conversation by the id in its path, and the
 * session's team is not the audience of one: a chat belongs to its
 * participants, a workflow run to whoever may see the workflow. Refuses (404)
 * anything else — see `assertConversationAccess`.
 */
const assertCallerCanOpen = async (
  c: Context<HonoLoggedAppType>,
  conversationId: string,
): Promise<void> => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  await assertConversationAccess({
    conversationId,
    teamId: team.id,
    organizationId: team.organizationId,
    userId: c.get("user").id,
  });
};

// ==================== //
// GET list             //
// ==================== //

chatFilesRoutes.get("/conversation/:id/files", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  await assertCallerCanOpen(c, conversationId);

  const rows = await db
    .select({
      id: aiChatFiles.id,
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
      size: aiChatFiles.size,
      hasMarkdown: aiChatFiles.hasMarkdown,
      status: aiChatFiles.status,
      errorMessage: aiChatFiles.errorMessage,
      documentId: aiChatFiles.documentId,
      messageId: aiChatFiles.messageId,
      createdAt: aiChatFiles.createdAt,
    })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        ne(aiChatFiles.status, "error"),
      ),
    )
    .orderBy(desc(aiChatFiles.createdAt));

  return c.json({ files: rows });
});

// ==================== //
// POST upload          //
// ==================== //

chatFilesRoutes.post("/conversation/:id/files", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  const form = await c.req.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Missing or invalid `file` field in multipart body",
      },
      400,
    );
  }

  await assertCallerCanOpen(c, conversationId);
  const row = await uploadChatFile({
    file,
    conversationId,
    teamId: team.id,
    userId: user.id,
  });

  return c.json(row, 201);
});

// ==================== //
// GET workspace hub    //
// ==================== //

/**
 * Everything this conversation holds — what the user attached AND what the
 * agent produced — as one list. `/files` above stays what it always was: the
 * attachment rows the prompt bar counts against its cap.
 */
chatFilesRoutes.get("/conversation/:id/workspace", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  await assertCallerCanOpen(c, conversationId);

  const files = await listConversationWorkspaceFiles({
    conversationId,
    teamId: team.id,
  });
  return c.json({ files });
});

/**
 * Whether ONE file is already in the Drive — asked per file, on demand.
 *
 * Not folded into the listing above: for an output the answer means reading
 * and hashing the bytes, so answering it for every file on every open would
 * download the whole workspace to render a list of names.
 */
chatFilesRoutes.get("/conversation/:id/workspace/drive-state", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  await assertCallerCanOpen(c, conversationId);

  const path = c.req.query("path");
  if (!path) {
    return c.json(
      { code: "VALIDATION_ERROR", message: "Missing `path` query parameter" },
      400,
    );
  }

  const resolved = resolveWorkspacePath(path);
  if (
    !resolved ||
    !DOWNLOADABLE_DIRS.has(resolved.relative.split("/")[0] ?? "")
  ) {
    return c.json(
      { code: "VALIDATION_ERROR", message: "Path is not a workspace file" },
      400,
    );
  }

  const state = await resolveDriveState({
    conversationId,
    teamId: team.id,
    path: resolved.relative,
  });
  return c.json(state);
});

/**
 * File one of this conversation's files into the Drive.
 *
 * Branches on where the file lives, because the two families keep different
 * books: an attachment has a row whose `documentId` must end up pointing at
 * the new document, an output has nothing but bytes. Sending both through one
 * path would leave the attachment row saying "not filed" about a file that is.
 *
 * `replaceDocumentId` lands the bytes on an existing document as its next
 * VERSION — what the `supersedes` state above exists to offer.
 */
chatFilesRoutes.post("/conversation/:id/workspace/promote", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const organization = c.get("organization");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  await assertCallerCanOpen(c, conversationId);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { code: "VALIDATION_ERROR", message: "Invalid JSON body" },
      400,
    );
  }
  const parsed =
    typeof body === "object" && body !== null
      ? (body as { path?: unknown; replaceDocumentId?: unknown })
      : {};
  const path = typeof parsed.path === "string" ? parsed.path : null;
  if (!path) {
    return c.json({ code: "VALIDATION_ERROR", message: "Missing `path`" }, 400);
  }
  const replaceDocumentId =
    typeof parsed.replaceDocumentId === "string"
      ? parsed.replaceDocumentId
      : undefined;

  const resolved = resolveWorkspacePath(path);
  if (
    !resolved ||
    !DOWNLOADABLE_DIRS.has(resolved.relative.split("/")[0] ?? "")
  ) {
    return c.json(
      { code: "VALIDATION_ERROR", message: "Path is not a workspace file" },
      400,
    );
  }

  const isAttachment =
    resolved.relative.split("/")[0] === WORKSPACE_DIRS.attachments;

  if (isAttachment && replaceDocumentId === undefined) {
    const filename = resolved.relative.split("/").pop() ?? resolved.relative;
    const row = await db.query.aiChatFiles.findFirst({
      where: { conversationId, filename },
      columns: { id: true },
    });
    if (!row) return throwHttpError(404, notFound("File not found"));

    const result = await promoteChatFilesToDrive({
      fileIds: [row.id],
      conversationId,
      organizationId: organization.id,
      teamId: team.id,
      userId: user.id,
    });
    const promoted = result.promoted[0];
    if (!promoted) {
      const failure = result.failed[0];
      return c.json(
        {
          code: "VALIDATION_ERROR",
          message: failure?.reason ?? "Could not save this file to the Drive",
        },
        400,
      );
    }
    return c.json({
      documentId: promoted.documentId,
      filename,
      versionNumber: 1,
      created: true,
      unchanged: false,
    });
  }

  try {
    const result = await promoteSandboxFileToDrive({
      conversationId,
      path: resolved.relative,
      organizationId: organization.id,
      teamId: team.id,
      userId: user.id,
      ...(replaceDocumentId !== undefined ? { replaceDocumentId } : {}),
      actorContext: { actor: "human", userId: user.id, conversationId },
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof PromoteSandboxFileError) {
      return c.json({ code: "VALIDATION_ERROR", message: err.message }, 400);
    }
    throw err;
  }
});

// ==================== //
// POST promote-to-drive //
// ==================== //

chatFilesRoutes.post("/conversation/:id/files/promote-to-drive", async (c) => {
  const user = c.get("user");
  const team = c.get("team");
  const organization = c.get("organization");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Invalid JSON body",
      },
      400,
    );
  }

  const fileIds =
    typeof body === "object" &&
    body !== null &&
    "fileIds" in body &&
    Array.isArray(body.fileIds)
      ? (body as { fileIds: unknown[] }).fileIds.filter(
          (v): v is string => typeof v === "string",
        )
      : null;

  if (!fileIds) {
    return c.json(
      {
        code: "VALIDATION_ERROR",
        message: "Missing or invalid `fileIds` array",
      },
      400,
    );
  }

  await assertCallerCanOpen(c, conversationId);
  const result = await promoteChatFilesToDrive({
    fileIds,
    conversationId,
    organizationId: organization.id,
    teamId: team.id,
    userId: user.id,
  });

  return c.json(result);
});

// ==================== //
// DELETE               //
// ==================== //

chatFilesRoutes.delete("/conversation/:id/files/:filename", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  const filename = c.req.param("filename");
  await assertCallerCanOpen(c, conversationId);

  const row = await db.query.aiChatFiles.findFirst({
    columns: { id: true, hasMarkdown: true },
    where: { conversationId, filename },
  });
  if (!row) {
    return throwHttpError(404, notFound("Chat file not found"));
  }

  // Façade `deleteFile` removes from sandbox + S3 in one call.
  await deleteFile(conversationId, buildAttachmentPath(filename));
  if (row.hasMarkdown) {
    await deleteFile(
      conversationId,
      buildAttachmentPath(sidecarFilename(filename)),
    );
  }

  await db
    .delete(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, conversationId),
        eq(aiChatFiles.id, row.id),
      ),
    );

  return c.json({ success: true });
});

// ==================== //
// GET download         //
// ==================== //

chatFilesRoutes.get("/conversation/:id/files/:filename/download", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");
  const filename = c.req.param("filename");

  // Access is a property of the CONVERSATION, so resolve it once here —
  // every resolution branch below needs exactly this check, and hoisting it
  // lets the `ai_chat_files` lookup drop its conversation join.
  await assertCallerCanOpen(c, conversationId);

  // Three ways to name the file, resolved in this order:
  //  1. An explicit `?path=` wins outright. It names a workspace path
  //     (`outputs/chart.png`) and is how markdown file links and the
  //     `presentFiles` cards address a file. Checked FIRST because a
  //     basename is ambiguous: a link to `outputs/report.pdf` was
  //     shadowed by an unrelated `attachments/report.pdf` upload that
  //     happened to share the basename, silently serving other bytes.
  //  2. User-uploaded files live in `ai_chat_files`, under
  //     `chatbot-sessions/{conv}/attachments/{filename}`.
  //  3. Tool-generated files with neither a row nor a `?path=` (old chat
  //     history that only kept the basename) fall back to a best-effort
  //     search across `outputs/`.
  const explicitPath = c.req.query("path");

  let s3RelativePath: string;

  if (explicitPath !== undefined && explicitPath.length > 0) {
    const resolved = resolveWorkspacePath(explicitPath);
    // Only the two S3-mirrored trees are servable: `attachments/` and
    // `outputs/` are backed up by `mirrorSandboxChanges` after every
    // sandbox run, while `skills/`, `drive/`, `runs/`, `context/`,
    // `memory/` and the workspace root are not — a presigned URL for
    // those would 404 on S3 anyway. Rejecting here makes that an honest
    // error instead of a broken link. `sanitizeSessionPath` (inside
    // `buildSessionKey`) already drops `.`/`..`; this is the second gate.
    const head = resolved?.relative.split("/")[0];
    if (!resolved || head === undefined || !DOWNLOADABLE_DIRS.has(head)) {
      return throwHttpError(404, notFound("File not found"));
    }
    s3RelativePath = resolved.relative;
  } else {
    const row = await db.query.aiChatFiles.findFirst({
      where: {
        conversationId,
        filename,
      },
      columns: { id: true },
    });

    if (row) {
      s3RelativePath = buildAttachmentPath(filename);
    } else {
      const candidates = await listSessionPaths(conversationId, "outputs");
      const match = candidates.find(
        (path) => path === filename || path.endsWith(`/${filename}`),
      );
      if (!match) {
        return throwHttpError(404, notFound("File not found"));
      }
      s3RelativePath = match;
    }
  }

  // `?preview=1` serves whatever a VIEWER should render for this file when
  // its own bytes are not it: a LibreOffice rendering for legacy Office,
  // OpenDocument, RTF and TIFF; the extracted markdown for mail. The registry
  // decides which, so an arbitrary file cannot be used to make the service
  // spend a Gotenberg call on it — a type that renders from its own bytes
  // answers `{ kind: null, url: null }` and the caller falls back.
  //
  // Named from the RESOLVED path rather than the route param: the extension
  // is what tells LibreOffice which importer to load, and `?path=` is the
  // parameter that actually decides which bytes are read.
  if (c.req.query("preview") === "1") {
    const previewName = s3RelativePath.split("/").pop() ?? filename;
    const bytes = await readSessionFile(conversationId, s3RelativePath);
    if (!bytes || bytes.length === 0) {
      return throwHttpError(404, notFound("File not found"));
    }

    const source = await getSessionFilePreviewSource({
      conversationId,
      filename: previewName,
      mimeType: mimeFromFilename(previewName),
      bytes,
      sidecarPath: `${WORKSPACE_DIRS.attachments}/${sidecarFilename(previewName)}`,
    });

    return c.json(source);
  }

  // `?disposition=attachment` signs a `Content-Disposition` into the
  // presigned URL so the browser saves the file instead of rendering it.
  // Download actions pass it; inline previews (the `<img>` in a
  // presentFiles card, the PDF viewer) deliberately do not.
  // Named from the route param, not from the resolved key: S3 segments are
  // sanitised to `[A-Za-z0-9._-]`, so keying the disposition off the stored
  // path would hand the user `mon_rapport.xlsx` for a file they know as
  // `mon rapport.xlsx`.
  const downloadFilename =
    c.req.query("disposition") === "attachment" ? filename : undefined;

  const url = await getPresignedUrl(
    buildSessionKey(conversationId, s3RelativePath),
    3600,
    downloadFilename !== undefined ? { downloadFilename } : {},
  );
  // `?presign=1` returns the presigned S3 URL as JSON instead of a
  // redirect. The "Open with Excel/Word/PowerPoint" buttons need this
  // because Office launches a fresh process WITHOUT the user's Better
  // Auth cookie — the 302 redirect path fails with 401, but the S3
  // presigned URL is self-authenticating for the next hour and Office
  // can fetch it directly.
  if (c.req.query("presign") === "1") {
    return c.json({ url });
  }
  return c.redirect(url, 302);
});

export { chatFilesRoutes };
