import db from "@fretik/shared/db";
import { updateDocument } from "@fretik/shared/services/documents/update";
import { createFolder } from "@fretik/shared/services/folders/create";
import { deleteFolders } from "@fretik/shared/services/folders/delete";
import { updateFolder } from "@fretik/shared/services/folders/update";
import { tool } from "ai";
import { z } from "zod";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { workflowWriteBackstop } from "../agents/shared/workflow-write-backstop";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `manageDrive` input schema. Exported so the never-throw contract (each
 * action validates its own required fields and returns a `toolError` instead
 * of throwing) is unit-tested directly, mirroring `manageRecordInputSchema`.
 */
export const manageDriveInputSchema = z.object({
  action: z.enum([
    "createFolder",
    "renameFolder",
    "moveFolder",
    "deleteFolder",
    "moveDocument",
  ]),
  name: z
    .string()
    .max(100)
    .optional()
    .describe("Folder name. Required for createFolder / renameFolder."),
  folderId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Target folder id. Required for renameFolder / moveFolder / deleteFolder.",
    ),
  documentId: z
    .string()
    .uuid()
    .optional()
    .describe("Document id to relocate. Required for moveDocument."),
  parentFolderId: z
    .string()
    .uuid()
    .nullish()
    .describe(
      "Destination folder id. For createFolder / moveFolder / moveDocument. Omit or null = Drive root.",
    ),
});

type ResolvedFolder = { id: string; name: string } | null;

/** Resolve a destination folder to `{ id, name }` (null = root), team-scoped. */
const resolveFolder = async (
  parentFolderId: string | null | undefined,
  teamId: string,
): Promise<ResolvedFolder> => {
  if (!parentFolderId) return null;
  const folder = await db.query.folders.findFirst({
    columns: { id: true, name: true },
    where: { id: parentFolderId, teamId },
  });
  return folder ?? null;
};

/**
 * Domain tool (deferred) — organise the Drive tree through the validated
 * shared folder/document services, so path recomputation, subtree counts, and
 * the `domain_events` journal stay consistent. Reads go through `listFolders` /
 * `listDocuments`; saving an attachment goes through `uploadToDrive`.
 */
export const createManageDriveTool = () =>
  tool({
    description: [
      "Organise the Drive: folders and where documents live. Journaled and team-scoped.",
      "",
      "- createFolder: name (+ optional parentFolderId). Creates a folder; omit parentFolderId for the root.",
      "- renameFolder: folderId + name.",
      "- moveFolder: folderId + parentFolderId (new parent; null = root).",
      "- deleteFolder: folderId. Deletes the folder AND its documents/subfolders — confirm with the user first.",
      "- moveDocument: documentId + parentFolderId (destination; null = root).",
      "",
      "Get folder ids from `listFolders`, document ids from `listDocuments`. To save a conversation attachment into the Drive, use `uploadToDrive`.",
    ].join("\n"),
    inputSchema: manageDriveInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const backstop = workflowWriteBackstop(ctx);
      if (backstop !== null) return backstop;
      const actor = agentEventActor(ctx);

      try {
        if (input.action === "createFolder") {
          if (!input.name) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "createFolder requires name.",
            );
          }
          if (!ctx.userId) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "createFolder requires a signed-in user context.",
            );
          }
          const folder = await createFolder({
            name: input.name,
            parentFolderId: input.parentFolderId ?? null,
            teamId: ctx.teamId,
            userId: ctx.userId,
            actor,
          });
          return {
            ok: true,
            action: input.action,
            folder: {
              id: folder.id,
              name: folder.name,
              parentFolderId: folder.parentFolderId,
            },
          };
        }

        if (input.action === "renameFolder") {
          if (!input.folderId || !input.name) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "renameFolder requires folderId and name.",
            );
          }
          const folder = await updateFolder({
            id: input.folderId,
            teamId: ctx.teamId,
            updates: { name: input.name },
            actor,
          });
          return {
            ok: true,
            action: input.action,
            folder: {
              id: folder.id,
              name: folder.name,
              parentFolderId: folder.parentFolderId,
            },
          };
        }

        if (input.action === "moveFolder") {
          if (!input.folderId) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "moveFolder requires folderId.",
            );
          }
          const folder = await updateFolder({
            id: input.folderId,
            teamId: ctx.teamId,
            updates: { parentFolderId: input.parentFolderId ?? null },
            actor,
          });
          return {
            ok: true,
            action: input.action,
            folder: {
              id: folder.id,
              name: folder.name,
              parentFolderId: folder.parentFolderId,
            },
            destinationFolder: await resolveFolder(
              input.parentFolderId,
              ctx.teamId,
            ),
          };
        }

        if (input.action === "deleteFolder") {
          if (!input.folderId) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "deleteFolder requires folderId.",
            );
          }
          await deleteFolders({
            ids: [input.folderId],
            teamId: ctx.teamId,
            actor,
          });
          return {
            ok: true,
            action: input.action,
            deleted: true,
            folderId: input.folderId,
          };
        }

        // moveDocument
        if (!input.documentId) {
          return toolError(
            TOOL_ERROR_CODES.DRIVE_ERROR,
            "moveDocument requires documentId.",
          );
        }
        // updateDocument does not validate the destination folder — check it
        // belongs to the team so a bad id fails loudly instead of silently
        // pointing the document at nothing.
        if (input.parentFolderId) {
          const dest = await resolveFolder(input.parentFolderId, ctx.teamId);
          if (!dest) {
            return toolError(
              TOOL_ERROR_CODES.NOT_FOUND,
              `Folder ${input.parentFolderId} not found for this team.`,
              "List folders with `listFolders` to get a valid id.",
            );
          }
        }
        const doc = await updateDocument({
          id: input.documentId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
          updates: { folderId: input.parentFolderId ?? null },
        });
        return {
          ok: true,
          action: input.action,
          document: doc
            ? { id: doc.id, filename: doc.originalFilename }
            : { id: input.documentId },
          destinationFolder: await resolveFolder(
            input.parentFolderId,
            ctx.teamId,
          ),
        };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          `manageDrive ${input.action} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
