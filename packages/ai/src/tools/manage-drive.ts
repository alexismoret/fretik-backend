import db from "@fretik/shared/db";
import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import { updateDocument } from "@fretik/shared/services/documents/update";
import { createFolder } from "@fretik/shared/services/folders/create";
import { deleteFolders } from "@fretik/shared/services/folders/delete";
import { updateFolder } from "@fretik/shared/services/folders/update";
import { tool } from "ai";
import { z } from "zod";
import {
  gateBuiltinWriteTool,
  resolveBuiltinPolicy,
} from "../agents/shared/policy-tool-gate";
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
    "renameDocument",
  ]),
  name: z
    .string()
    .max(100)
    .optional()
    .describe(
      "New name. Required for createFolder / renameFolder / renameDocument.",
    ),
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
    .describe(
      "Document to act on. Required for moveDocument / renameDocument.",
    ),
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
 * Names for the approval card. The raw args are ids, and nobody can approve
 * "delete folder 3f2a…" — so the tool resolves them here, at proposal time,
 * the way `record_write` attaches its labels. Only called when the policy
 * actually gates this action, so the auto path pays for no lookup.
 */
const driveSummaryFields = async (
  input: z.infer<typeof manageDriveInputSchema>,
  teamId: string,
): Promise<ToolApprovalSummaryField[]> => {
  const fields: ToolApprovalSummaryField[] = [];

  if (input.folderId) {
    const folder = await resolveFolder(input.folderId, teamId);
    if (folder) fields.push({ labelKey: "folder", value: folder.name });
  }
  if (input.documentId) {
    const document = await db.query.documents.findFirst({
      columns: { originalFilename: true },
      where: { id: input.documentId, teamId },
    });
    if (document) {
      fields.push({ labelKey: "document", value: document.originalFilename });
    }
  }
  if (input.name) fields.push({ labelKey: "name", value: input.name });
  // Root has no name to show, and `value` is displayed verbatim — a literal
  // "Drive root" here would be English in a French UI. The card's own preview
  // already words the root case.
  const destination = await resolveFolder(input.parentFolderId, teamId);
  if (destination) {
    fields.push({ labelKey: "destination", value: destination.name });
  }
  return fields;
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
      "- renameDocument: documentId + name. The file type is kept whatever you send, so name it as a title.",
      "",
      "Get folder ids from `listFolders`, document ids from `listDocuments`. To save a conversation attachment into the Drive, use `uploadToDrive`; to change what a document SAYS, use `manageDocument`.",
    ].join("\n"),
    inputSchema: manageDriveInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const backstop = workflowWriteBackstop(ctx);
      if (backstop !== null) return backstop;
      const actor = agentEventActor(ctx);

      try {
        // Destination check BEFORE the gate: an approval must never be opened
        // for a write that cannot run. `updateDocument` does not validate the
        // destination, so a bad id would ride into the approval payload, get
        // approved by a human, and then silently point the document at nothing.
        // (`updateFolder` validates its own new parent, so moveFolder/
        // createFolder need nothing here.)
        if (input.action === "moveDocument" && input.parentFolderId) {
          const dest = await resolveFolder(input.parentFolderId, ctx.teamId);
          if (!dest) {
            return toolError(
              TOOL_ERROR_CODES.NOT_FOUND,
              `Folder ${input.parentFolderId} not found for this team.`,
              "List folders with `listFolders` to get a valid id.",
            );
          }
        }

        // Tool-permission gate: `blocked` → error, `approval` → pause with the
        // normalized args (the apply map reads only the keys each action needs),
        // `auto` → proceed. Ids are already model-supplied, so no resolution
        // step — except the card's names, resolved only when a card will
        // actually open (this resolve is in-memory; the gate repeats it free).
        const summaryFields =
          resolveBuiltinPolicy(ctx, "manageDrive", input.action) === "approval"
            ? await driveSummaryFields(input, ctx.teamId)
            : undefined;
        const gate = await gateBuiltinWriteTool(ctx, {
          toolName: "manageDrive",
          args: {
            action: input.action,
            name: input.name,
            folderId: input.folderId,
            documentId: input.documentId,
            parentFolderId: input.parentFolderId ?? null,
          },
          ...(summaryFields === undefined ? {} : { summaryFields }),
        });
        if (gate !== null) return gate;

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

        if (input.action === "renameDocument") {
          if (!input.documentId || !input.name) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "renameDocument requires documentId and name.",
            );
          }
          // `updateDocument` re-appends the current extension: every S3 key a
          // document owns derives from this name, so a rename that changed the
          // extension would leave the bytes behind.
          const renamed = await updateDocument({
            id: input.documentId,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
            updates: { originalFilename: input.name },
          });
          return {
            ok: true,
            action: input.action,
            document: {
              id: input.documentId,
              name: renamed?.originalFilename ?? input.name,
            },
          };
        }

        // moveDocument
        if (!input.documentId) {
          return toolError(
            TOOL_ERROR_CODES.DRIVE_ERROR,
            "moveDocument requires documentId.",
          );
        }
        // Destination already validated above, before the gate.
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
