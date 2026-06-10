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
import { OpenAPIHono } from "@hono/zod-openapi";
import { and, desc, eq, ne } from "drizzle-orm";
import { deleteFile, WORKSPACE_DIRS } from "../lib/conversation-storage";
import { promoteChatFilesToDrive } from "../services/chat-files/promote-to-drive";
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
    Array.isArray((body as { fileIds: unknown }).fileIds)
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

  // Two paths share this endpoint:
  //  1. User-uploaded files live in `ai_chat_files` — the original
  //     flow. We check team ownership via the row's conversation join.
  //     The S3 key is `chatbot-sessions/{conv}/attachments/{filename}`.
  //  2. Tool-generated files (created by `presentFiles` via the agent's
  //     `python` output) are written directly to the S3 session
  //     folder under `outputs/{path}` without a DB row — no upload
  //     flow, no status machine, no sidecar. For those we resolve
  //     team ownership via the parent conversation and confirm the
  //     file actually exists in S3 before presigning. The frontend
  //     passes the `path` query param to disambiguate (e.g.
  //     `?path=outputs/chart.png`).
  const row = await db.query.aiChatFiles.findFirst({
    where: {
      conversationId,
      filename,
    },
    with: {
      conversation: { columns: { teamId: true } },
    },
  });

  let s3RelativePath: string;

  if (row) {
    if (!row.conversation) {
      return throwHttpError(404, notFound("Chat file not found"));
    }
    if (row.conversation.teamId !== team.id) {
      return throwHttpError(403, forbidden());
    }
    s3RelativePath = buildAttachmentPath(filename);
  } else {
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
    // For tool-generated files, the caller supplies the workspace
    // path explicitly (`?path=outputs/chart.png`). Fall back to a
    // best-effort search across `outputs/` if missing — keeps the
    // download URL backwards compatible with old chat history that
    // only knows the basename.
    const explicitPath = c.req.query("path");
    if (explicitPath) {
      s3RelativePath = explicitPath;
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

  const url = await getPresignedUrl(
    buildSessionKey(conversationId, s3RelativePath),
    3600,
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
