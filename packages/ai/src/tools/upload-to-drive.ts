import db from "@fretik/shared/db";
import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
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
 * `uploadToDrive` — the inverse of `downloadDriveDocument`: persist files from
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
 *
 * **Takes a LIST.** Saving eight generated files used to be eight tool calls
 * and — on a team that gates Drive writes — eight approval cards for one
 * intention. One call is one policy decision, one card listing every filename,
 * and one grant that applies the whole set. Per-file results come back in
 * `saved` / `failed`, so a single unsupported type costs its own row instead
 * of the batch.
 */

/** Files one call may carry. Past this the approval card stops being readable
 * — which is the thing the card exists for. */
const MAX_FILES = 50;

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

/** One file's outcome. `created: false` means it landed on an existing doc. */
interface SavedFile {
  file: string;
  documentId: string;
  filename: string;
  versionNumber: number;
  created: boolean;
}

interface FailedFile {
  file: string;
  reason: string;
}

export const createUploadToDriveTool = () =>
  tool({
    description: [
      "Save files from this conversation into the team's Drive — the user's attachments, or files you produced in your workspace. The inverse of `downloadDriveDocument`, and what makes a conversation-only file permanent, team-visible, and searchable from every future conversation.",
      "",
      "When to use:",
      "- The user asks to keep / archive / file something in the Drive.",
      "- You produced deliverables worth keeping — offer them, framed by their benefit.",
      "- You regenerated a document that already exists in the Drive: pass `replaceDocumentId` so it becomes that document's next version instead of a duplicate.",
      "",
      "When NOT to use: the file is already a Drive document and unchanged — nothing to save.",
      "",
      "Inputs:",
      `- files (required): list of files to save. A bare filename is one of the user's attachments; a workspace path is something you made (\`${WORKSPACE_DIRS.outputs}/report.pdf\`). Same resolution as \`read\`. Pass every file you want saved in ONE call — that is one approval instead of one per file. Max ${MAX_FILES.toString()}.`,
      "- replaceDocumentId (optional): id of the document these bytes replace. Its history, links, and place in the Drive are kept; the previous content stays restorable. Only valid with exactly one workspace file — a version has one predecessor.",
      "- parentFolderId (optional): target folder id (from `listFolders`), applied to every file. Ignored when replacing. Omit for the Drive root.",
      "",
      "Output: { ok, saved: [{ file, documentId, filename, versionNumber, created }], failed: [{ file, reason }] }. `created: false` means it landed on an existing document. A batch can half-succeed — read `failed` before reporting. Indexing runs in the background.",
      "",
      "Constraints:",
      "- The Drive accepts a narrower type set than chat; unsupported types are refused per file.",
      "- A replacement keeps the document's type — save a different format as a new document.",
      "- Idempotent: identical bytes already saved to the same place create nothing.",
    ].join("\n"),
    inputSchema: z.object({
      files: z
        .array(z.string().min(1))
        .min(1)
        .max(MAX_FILES)
        .describe(
          `Attachment filenames as listed in the attached-files block, and/or workspace paths such as \`${WORKSPACE_DIRS.outputs}/report.pdf\`. Pass them all in one call.`,
        ),
      replaceDocumentId: z
        .uuid()
        .nullish()
        .describe(
          "Document whose content these bytes replace, creating its next version. Only with a single workspace file.",
        ),
      parentFolderId: z
        .uuid()
        .nullish()
        .describe(
          "Target Drive folder id (from `listFolders`). Omit or null for the Drive root.",
        ),
    }),
    execute: async ({ files, replaceDocumentId, parentFolderId }, options) => {
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
      const conversationId = ctx.conversationId;
      const userId = ctx.userId;

      // De-duplicate before anything else: the same file named twice would
      // otherwise be promoted twice and, on the sandbox path, produce two
      // documents with no relation between them.
      const requested = [...new Set(files)];

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

      const sources = requested.map((file) => ({
        file,
        source: resolveUploadSource(file),
      }));
      const workspacePaths = sources.filter(
        (entry) => entry.source.kind === "workspace",
      );
      const attachmentNames = sources.filter(
        (entry) => entry.source.kind === "attachment",
      );

      if (replaceDocumentId) {
        // A version has exactly one predecessor, so "replace this document
        // with these five files" has no meaning worth guessing at.
        if (requested.length > 1 || workspacePaths.length !== 1) {
          return toolError(
            TOOL_ERROR_CODES.DRIVE_ERROR,
            "Only a single file you produced can replace a document's content.",
            `Write the new content to \`${WORKSPACE_DIRS.outputs}/\` and pass that one path.`,
          );
        }
      }

      // Resolve every attachment up front so a name that matches nothing is
      // reported before the gate — a user should not be asked to approve a
      // save the tool already knows it cannot perform.
      const chatFiles = new Map<
        string,
        { id: string; documentId: string | null; status: string }
      >();
      const failed: FailedFile[] = [];
      for (const entry of attachmentNames) {
        if (entry.source.kind !== "attachment") continue;
        const name = entry.source.name;
        const chatFile = await db.query.aiChatFiles.findFirst({
          columns: { id: true, documentId: true, status: true },
          where: { conversationId, filename: name },
        });
        if (!chatFile) {
          failed.push({
            file: entry.file,
            reason: `No attached file named "${name}" in this conversation. Use a filename from the attached-files block.`,
          });
          continue;
        }
        if (chatFile.status === "error") {
          failed.push({
            file: entry.file,
            reason: `Attached file "${name}" failed to process and cannot be saved.`,
          });
          continue;
        }
        chatFiles.set(entry.file, chatFile);
      }

      const promotable = [
        ...workspacePaths.map((entry) => entry.file),
        ...attachmentNames
          .filter((entry) => chatFiles.has(entry.file))
          .map((entry) => entry.file),
      ];
      // Nothing left to do — skip the gate rather than asking a human to
      // approve a set that is entirely unresolvable.
      if (promotable.length === 0) {
        return { ok: false, saved: [], failed };
      }

      // ONE gate for the whole batch — one policy decision, one approval
      // card, one grant. The stored args mirror `TOOL_CALL_APPLY.uploadToDrive`
      // so a grant re-applies exactly this set.
      const gate = await gateBuiltinWriteTool(ctx, {
        toolName: "uploadToDrive",
        args: {
          paths: workspacePaths.map((entry) =>
            entry.source.kind === "workspace" ? entry.source.path : entry.file,
          ),
          fileIds: attachmentNames
            .map((entry) => chatFiles.get(entry.file)?.id)
            .filter((id): id is string => id !== undefined),
          folderId: parentFolderId ?? null,
          ...(replaceDocumentId ? { replaceDocumentId } : {}),
        },
        summaryFields: uploadSummaryFields(promotable),
      });
      if (gate !== null) return gate;

      const saved: SavedFile[] = [];

      // Workspace files: one promotion each (each is its own S3 read and its
      // own document row), but all under the single approval above.
      for (const entry of workspacePaths) {
        if (entry.source.kind !== "workspace") continue;
        try {
          const result = await promoteSandboxFileToDrive({
            conversationId,
            path: entry.source.path,
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            userId,
            folderId: parentFolderId ?? null,
            ...(replaceDocumentId ? { replaceDocumentId } : {}),
            actorContext: { actor: "agent", userId, conversationId },
          });
          saved.push({
            file: entry.file,
            documentId: result.documentId,
            filename: result.filename,
            versionNumber: result.versionNumber,
            created: result.created,
          });
        } catch (error) {
          if (error instanceof PromoteSandboxFileError) {
            failed.push({
              file: entry.file,
              reason:
                error.code === "not_found"
                  ? `${error.message} List your workspace with \`bash\` to check the exact path.`
                  : error.message,
            });
            continue;
          }
          throw error;
        }
      }

      // Attachments: the service is already set-based, so the whole list is
      // one call.
      const resolvedAttachments = attachmentNames.filter((entry) =>
        chatFiles.has(entry.file),
      );
      if (resolvedAttachments.length > 0) {
        const { promoted, failed: promotionFailures } =
          await promoteChatFilesToDrive({
            fileIds: resolvedAttachments.map(
              (entry) => chatFiles.get(entry.file)!.id,
            ),
            conversationId,
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            userId,
            folderId: parentFolderId ?? null,
          });
        const fileNameById = new Map(
          resolvedAttachments.map((entry) => [
            chatFiles.get(entry.file)!.id,
            entry,
          ]),
        );
        for (const ok of promoted) {
          const entry = fileNameById.get(ok.fileId);
          if (entry === undefined) continue;
          saved.push({
            file: entry.file,
            documentId: ok.documentId,
            filename:
              entry.source.kind === "attachment"
                ? entry.source.name
                : entry.file,
            versionNumber: 1,
            created: true,
          });
        }
        for (const failure of promotionFailures) {
          const entry = fileNameById.get(failure.fileId);
          failed.push({
            file: entry?.file ?? failure.fileId,
            reason: failure.reason,
          });
        }
      }

      return {
        ok: failed.length === 0,
        saved,
        failed,
        folderId: parentFolderId ?? null,
        status: "processing",
      };
    },
  });

/**
 * What a person reviewing the approval card can actually check: the file
 * names, and how many there are. The destination folder is deliberately NOT
 * on it — it is a UUID, and a reviewer cannot tell one from another.
 */
const uploadSummaryFields = (files: string[]): ToolApprovalSummaryField[] => {
  const head = files.slice(0, 10).join("\n");
  return [
    { labelKey: "count", value: files.length.toString() },
    {
      labelKey: "files",
      value:
        files.length > 10
          ? `${head}\n…(+${(files.length - 10).toString()})`
          : head,
    },
  ];
};
