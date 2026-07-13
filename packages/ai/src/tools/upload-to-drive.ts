import db from "@fretik/shared/db";
import { promoteChatFilesToDrive } from "@fretik/shared/services/chat-files/promote-to-drive";
import { tool } from "ai";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowWriteBackstop } from "../agents/shared/workflow-write-backstop";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `uploadToDrive` — the inverse of `downloadDriveDocument`: persist a file the
 * user attached to THIS conversation into the team's Drive (`documents` table),
 * optionally inside a folder.
 *
 * Wraps the existing `promoteChatFilesToDrive` service (server-side S3 copy +
 * document row + processing enqueue) so a chat/drive upload and this tool share
 * one code path. The model references attachments by filename (the
 * `<attached_files>` block never exposes ids); `ai_chat_files` is unique per
 * `(conversation, filename)`, so the lookup is unambiguous.
 */
export const createUploadToDriveTool = () =>
  tool({
    description: [
      "Save a file the user attached to this conversation into the team's Drive, optionally inside a folder. The inverse of `downloadDriveDocument`.",
      "",
      "When to use:",
      "- The user asks to keep / archive / file an uploaded attachment in the Drive.",
      "- A generated or edited file already lives as a conversation attachment and should become a durable Drive document.",
      "",
      "When NOT to use:",
      "- The file is already a Drive document (it has a documentId) — nothing to upload.",
      "- You only need to read or process the attachment — use `read` / `vision` / `python` directly.",
      "",
      "Inputs:",
      "- filename (required): exact name of the attached file, as shown in the attached-files block.",
      "- parentFolderId (optional): target folder id (from `listFolders`). Omit for the Drive root.",
      "",
      "Output: { ok, documentId, filename, folderId, status }. Processing (OCR / indexing) runs in the background — the document is usable once ready.",
      "",
      "Constraints:",
      "- Only files attached to the current conversation. Unknown filename → NOT_FOUND.",
      "- The Drive accepts a narrower type set than chat; unsupported types are refused.",
      "- Idempotent: re-uploading an already-saved file returns its existing documentId.",
    ].join("\n"),
    inputSchema: z.object({
      filename: z
        .string()
        .min(1)
        .describe(
          "Exact name of the attached file, as listed in the attached-files block.",
        ),
      parentFolderId: z
        .string()
        .uuid()
        .nullish()
        .describe(
          "Target Drive folder id (from `listFolders`). Omit or null for the Drive root.",
        ),
    }),
    execute: async ({ filename, parentFolderId }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return toolError(
          TOOL_ERROR_CODES.NO_CONVERSATION,
          "uploadToDrive is only available inside a conversation with attached files.",
        );
      }
      const backstop = workflowWriteBackstop(ctx);
      if (backstop !== null) return backstop;
      if (!ctx.userId) {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          "uploadToDrive requires a signed-in user context.",
        );
      }

      // Resolve the attachment by filename — unique per (conversation, filename).
      const chatFile = await db.query.aiChatFiles.findFirst({
        columns: { id: true, documentId: true, status: true },
        where: { conversationId: ctx.conversationId, filename },
      });
      if (!chatFile) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `No attached file named "${filename}" in this conversation.`,
          "Use a filename from the attached-files block.",
        );
      }
      if (chatFile.status === "error") {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          `Attached file "${filename}" failed to process and cannot be saved.`,
        );
      }

      // Validate the destination folder belongs to the caller's team.
      if (parentFolderId) {
        const folder = await db.query.folders.findFirst({
          columns: { id: true },
          where: { id: parentFolderId, teamId: ctx.teamId },
        });
        if (!folder) {
          return toolError(
            TOOL_ERROR_CODES.NOT_FOUND,
            `Folder ${parentFolderId} not found for this team.`,
            "List folders with `listFolders` to get a valid id.",
          );
        }
      }

      const gate = await gateBuiltinWriteTool(ctx, {
        toolName: "uploadToDrive",
        args: { fileId: chatFile.id, folderId: parentFolderId ?? null },
      });
      if (gate !== null) return gate;

      const { promoted, failed } = await promoteChatFilesToDrive({
        fileIds: [chatFile.id],
        conversationId: ctx.conversationId,
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        folderId: parentFolderId ?? null,
      });

      const ok = promoted[0];
      if (!ok) {
        const reason = failed[0]?.reason ?? "Upload failed.";
        return toolError(TOOL_ERROR_CODES.DRIVE_ERROR, reason);
      }

      return {
        ok: true,
        documentId: ok.documentId,
        filename,
        folderId: parentFolderId ?? null,
        status: "processing",
      };
    },
  });
