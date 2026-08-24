import db from "@fretik/shared/db";
import {
  PromoteSandboxFileError,
  promoteSandboxFileToDrive,
} from "@fretik/shared/services/chat-files/promote-sandbox-file-to-drive";
import { promoteChatFilesToDrive } from "@fretik/shared/services/chat-files/promote-to-drive";
import { tool } from "ai";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowWriteBackstop } from "../agents/shared/workflow-write-backstop";
import { WORKSPACE_DIRS } from "../lib/conversation-storage";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `uploadToDrive` — the inverse of `downloadDriveDocument`: persist a file from
 * THIS conversation into the team's Drive (`documents` table).
 *
 * Two sources behind one param, resolved exactly like `read` resolves its path:
 * a bare filename is an attachment the user brought, anything with a slash is a
 * workspace file the agent produced. They take different services because they
 * are different things — an attachment has an `ai_chat_files` row carrying its
 * own promotion idempotence, a sandbox output has nothing but bytes on S3.
 *
 * `replaceDocumentId` makes those bytes the next VERSION of an existing
 * document rather than a second one. Without it, an agent that regenerates a
 * deliverable leaves the Drive holding two same-named files and no link
 * between them.
 */
/**
 * Which of the two sources a `file` value names.
 *
 * Same rule as `read`: a bare name is one of the user's attachments, anything
 * with a slash is a workspace path. `attachments/x.pdf` and a bare `x.pdf` are
 * the SAME file, so both resolve to the attachment — routing the prefixed form
 * through the workspace would promote the bytes while losing the chat-file
 * row's `documentId` linkage, and a second promotion would then duplicate it.
 *
 * Exported for its test: this is the branch that decides which service runs.
 */
export type UploadSource =
  { kind: "attachment"; name: string } | { kind: "workspace"; path: string };

export const resolveUploadSource = (file: string): UploadSource => {
  const attachmentPrefix = `${WORKSPACE_DIRS.attachments}/`;
  const normalised = file.startsWith(attachmentPrefix)
    ? file.slice(attachmentPrefix.length)
    : file;
  return normalised.includes("/")
    ? { kind: "workspace", path: normalised }
    : { kind: "attachment", name: normalised };
};

export const createUploadToDriveTool = () =>
  tool({
    description: [
      "Save a file from this conversation into the team's Drive — a user's attachment, or one you produced in your workspace. The inverse of `downloadDriveDocument`, and what makes a conversation-only file permanent, team-visible, and searchable from every future conversation.",
      "",
      "When to use:",
      "- The user asks to keep / archive / file something in the Drive.",
      "- You produced a deliverable worth keeping — offer it, framed by its benefit.",
      "- You regenerated a document that already exists in the Drive: pass `replaceDocumentId` so it becomes that document's next version instead of a duplicate.",
      "",
      "When NOT to use: the file is already a Drive document and unchanged — nothing to save.",
      "",
      "Inputs:",
      `- file (required): a bare filename for one of the user's attachments, or a workspace path for something you made (\`${WORKSPACE_DIRS.outputs}/report.pdf\`). Same resolution as \`read\`.`,
      "- replaceDocumentId (optional): id of the document these bytes replace. Its history, links, and place in the Drive are kept; the previous content stays restorable.",
      "- parentFolderId (optional): target folder id (from `listFolders`). Ignored when replacing. Omit for the Drive root.",
      "",
      "Output: { ok, documentId, filename, versionNumber, created, folderId, status }. `created: false` means it landed on an existing document. Indexing runs in the background.",
      "",
      "Constraints:",
      "- The Drive accepts a narrower type set than chat; unsupported types are refused.",
      "- A replacement keeps the document's type — save a different format as a new document.",
      "- Idempotent: identical bytes already saved to the same place create nothing.",
    ].join("\n"),
    inputSchema: z.object({
      file: z
        .string()
        .min(1)
        .describe(
          `Attachment filename as listed in the attached-files block, or a workspace path such as \`${WORKSPACE_DIRS.outputs}/report.pdf\`.`,
        ),
      replaceDocumentId: z
        .uuid()
        .nullish()
        .describe(
          "Document whose content these bytes replace, creating its next version.",
        ),
      parentFolderId: z
        .uuid()
        .nullish()
        .describe(
          "Target Drive folder id (from `listFolders`). Omit or null for the Drive root.",
        ),
    }),
    execute: async ({ file, replaceDocumentId, parentFolderId }, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.conversationId) {
        return toolError(
          TOOL_ERROR_CODES.NO_CONVERSATION,
          "uploadToDrive is only available inside a conversation.",
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

      const source = resolveUploadSource(file);

      if (source.kind === "workspace") {
        // Same policy gate as the attachment path — a team that requires
        // approval for Drive writes means it whatever the bytes came from.
        // Args mirror `TOOL_CALL_APPLY.uploadToDrive`'s `path` branch so a
        // grant re-applies exactly this write.
        const sandboxGate = await gateBuiltinWriteTool(ctx, {
          toolName: "uploadToDrive",
          args: {
            path: source.path,
            folderId: parentFolderId ?? null,
            ...(replaceDocumentId ? { replaceDocumentId } : {}),
          },
        });
        if (sandboxGate !== null) return sandboxGate;

        try {
          const result = await promoteSandboxFileToDrive({
            conversationId: ctx.conversationId,
            path: source.path,
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            userId: ctx.userId,
            folderId: parentFolderId ?? null,
            ...(replaceDocumentId ? { replaceDocumentId } : {}),
            actorContext: {
              actor: "agent",
              userId: ctx.userId,
              conversationId: ctx.conversationId,
            },
          });
          return {
            ok: true,
            documentId: result.documentId,
            filename: result.filename,
            versionNumber: result.versionNumber,
            created: result.created,
            folderId: parentFolderId ?? null,
            status: "processing",
          };
        } catch (error) {
          if (error instanceof PromoteSandboxFileError) {
            return toolError(
              error.code === "not_found"
                ? TOOL_ERROR_CODES.NOT_FOUND
                : TOOL_ERROR_CODES.DRIVE_ERROR,
              error.message,
              error.code === "not_found"
                ? "List your workspace with `bash` to check the exact path."
                : undefined,
            );
          }
          throw error;
        }
      }

      if (replaceDocumentId) {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          "Only a file you produced can replace a document's content.",
          `Write the new content to \`${WORKSPACE_DIRS.outputs}/\` first, then pass that path.`,
        );
      }

      // Resolve the attachment by filename — unique per (conversation, filename).
      const chatFile = await db.query.aiChatFiles.findFirst({
        columns: { id: true, documentId: true, status: true },
        where: { conversationId: ctx.conversationId, filename: source.name },
      });
      if (!chatFile) {
        return toolError(
          TOOL_ERROR_CODES.NOT_FOUND,
          `No attached file named "${source.name}" in this conversation.`,
          "Use a filename from the attached-files block.",
        );
      }
      if (chatFile.status === "error") {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          `Attached file "${source.name}" failed to process and cannot be saved.`,
        );
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
        filename: source.name,
        versionNumber: 1,
        created: true,
        folderId: parentFolderId ?? null,
        status: "processing",
      };
    },
  });
