import db from "@fretik/shared/db";
import { aiChatFiles } from "@fretik/shared/db/schema";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  buildSessionKey,
  listSessionPaths,
} from "@fretik/shared/lib/chatbot-session-storage";
import {
  forbidden,
  notFound,
  teamRequired,
  throwHttpError,
} from "@fretik/shared/lib/errors";
import { getPresignedUrl } from "@fretik/shared/lib/s3";
import { promoteChatFilesToDrive } from "@fretik/shared/services/chat-files/promote-to-drive";
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, ne } from "drizzle-orm";
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
  WORKSPACE_DIRS.outputs,
]);

// ==================== //
// GET list             //
// ==================== //

chatFilesRoutes.get("/conversation/:id/files", async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const conversationId = c.req.param("id");

  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { id: true, teamId: true },
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }
  if (conversation.teamId !== team.id) {
    return throwHttpError(403, forbidden());
  }

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

  const row = await uploadChatFile({
    file,
    conversationId,
    teamId: team.id,
    userId: user.id,
  });

  return c.json(row, 201);
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

  const row = await db.query.aiChatFiles.findFirst({
    where: {
      conversationId,
      filename,
    },
    with: {
      conversation: { columns: { teamId: true } },
    },
  });

  if (!row || !row.conversation) {
    return throwHttpError(404, notFound("Chat file not found"));
  }
  if (row.conversation.teamId !== team.id) {
    return throwHttpError(403, forbidden());
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

  // Team ownership is a property of the CONVERSATION, so resolve it once
  // here — every resolution branch below needs exactly this check, and
  // hoisting it lets the `ai_chat_files` lookup drop its conversation join.
  const conversation = await db.query.aiConversations.findFirst({
    where: { id: conversationId },
    columns: { id: true, teamId: true },
  });
  if (!conversation) {
    return throwHttpError(404, notFound("Conversation not found"));
  }
  if (conversation.teamId !== team.id) {
    return throwHttpError(403, forbidden());
  }

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
