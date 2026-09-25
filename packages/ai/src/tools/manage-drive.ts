import db from "@fretik/shared/db";
import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import { FOLDER_DESCRIPTION_MAX_CHARS } from "@fretik/shared/schemas/folders";
import { moveDocuments } from "@fretik/shared/services/documents/move";
import { updateDocument } from "@fretik/shared/services/documents/update";
import { createFolder } from "@fretik/shared/services/folders/create";
import { deleteFolders } from "@fretik/shared/services/folders/delete";
import { moveFolders } from "@fretik/shared/services/folders/move";
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
 * Documents one `moveDocument` call may carry.
 *
 * Tidying a Drive is hundreds of moves, and one document per call made it one
 * agent step each: a turn has 30, so the agent filed 30 documents and stopped.
 * 200 keeps the ids the model has to write out to a few thousand tokens (a
 * uuid is ~25), which it copies reliably and streams in seconds, while a
 * thousand-document Drive still takes a handful of calls. Past it the
 * approval card, when a team gates moves, stops being reviewable anyway.
 */
export const MAX_DOCUMENTS_PER_CALL = 200;

/**
 * Folders one `moveFolder` / `deleteFolder` call may carry. Lower than
 * documents: each folder move rewrites a subtree's paths, and each deleted
 * folder takes its documents with it, so a reviewer must be able to read the
 * whole list on the card.
 */
export const MAX_FOLDERS_PER_CALL = 50;

/**
 * `manageDrive` input schema. Exported so the never-throw contract (each
 * action validates its own required fields and returns a `toolError` instead
 * of throwing) is unit-tested directly, mirroring `manageRecordInputSchema`.
 */
export const manageDriveInputSchema = z.object({
  action: z.enum([
    "createFolder",
    "renameFolder",
    "describeFolder",
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
    .describe("Folder to act on. Required for renameFolder / describeFolder."),
  folderIds: z
    .array(z.string().uuid())
    .max(MAX_FOLDERS_PER_CALL)
    .optional()
    .describe(
      `Folders to move or delete, all at once. For moveFolder / deleteFolder. Max ${MAX_FOLDERS_PER_CALL.toString()}.`,
    ),
  documentId: z
    .string()
    .uuid()
    .optional()
    .describe("Document to rename. Required for renameDocument."),
  documentIds: z
    .array(z.string().uuid())
    .max(MAX_DOCUMENTS_PER_CALL)
    .optional()
    .describe(
      `Documents to move, all to the same parentFolderId. For moveDocument. Max ${MAX_DOCUMENTS_PER_CALL.toString()}.`,
    ),
  parentFolderId: z
    .string()
    .uuid()
    .nullish()
    .describe(
      "Destination folder id. For createFolder / moveFolder / moveDocument. Omit or null = Drive root.",
    ),
  description: z
    .string()
    .max(FOLDER_DESCRIPTION_MAX_CHARS)
    .optional()
    .describe(
      "What belongs in the folder, one sentence naming the KIND of document ('Signed client contracts and their amendments'). For createFolder / describeFolder; \"\" on describeFolder clears it.",
    ),
});

type ManageDriveInput = z.infer<typeof manageDriveInputSchema>;

/**
 * The ids a batch action applies to: the list, plus the singular id a model
 * may still send out of habit (every call in an older conversation's history
 * carries one). Deduplicated, order kept. Exported for its test.
 */
export const batchTargets = (
  list: readonly string[] | undefined,
  single: string | undefined,
): string[] => [...new Set([...(list ?? []), ...(single ? [single] : [])])];

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

/** Names shown on an approval card: the first ten, then a count. */
const CARD_NAMES = 10;
const nameList = (names: readonly string[]): string =>
  names.length > CARD_NAMES
    ? `${names.slice(0, CARD_NAMES).join(", ")} (+${(names.length - CARD_NAMES).toString()})`
    : names.join(", ");

/** One row for a single target, a count and a name list for several. */
const targetFields = (
  names: readonly string[],
  one: "folder" | "document",
): ToolApprovalSummaryField[] => {
  if (names.length === 0) return [];
  if (names.length === 1) return [{ labelKey: one, value: names[0] ?? "" }];
  return [
    { labelKey: "count", value: names.length.toString() },
    { labelKey: `${one}s`, value: nameList(names) },
  ];
};

/**
 * Names for the approval card. The raw args are ids, and nobody can approve
 * "delete folder 3f2a…" — so the tool resolves them here, at proposal time,
 * the way `record_write` attaches its labels. Only called when the policy
 * actually gates this action, so the auto path pays for no lookup.
 */
const driveSummaryFields = async (
  input: ManageDriveInput,
  targets: { folderIds: string[]; documentIds: string[] },
  teamId: string,
): Promise<ToolApprovalSummaryField[]> => {
  const fields: ToolApprovalSummaryField[] = [];

  if (targets.folderIds.length > 0) {
    const rows = await db.query.folders.findMany({
      columns: { name: true },
      where: { id: { in: targets.folderIds }, teamId },
    });
    fields.push(
      ...targetFields(
        rows.map((r) => r.name),
        "folder",
      ),
    );
  }
  if (targets.documentIds.length > 0) {
    const rows = await db.query.documents.findMany({
      columns: { originalFilename: true },
      where: { id: { in: targets.documentIds }, teamId },
    });
    fields.push(
      ...targetFields(
        rows.map((r) => r.originalFilename),
        "document",
      ),
    );
  }
  if (input.name) fields.push({ labelKey: "name", value: input.name });
  if (input.description) {
    fields.push({ labelKey: "description", value: input.description });
  }
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
 * What each action applies to. The batch actions take the lists (plus a
 * stray singular id); the others take exactly the singular one.
 */
const resolveTargets = (
  input: ManageDriveInput,
): { folderIds: string[]; documentIds: string[] } => {
  switch (input.action) {
    case "moveFolder":
    case "deleteFolder":
      return {
        folderIds: batchTargets(input.folderIds, input.folderId),
        documentIds: [],
      };
    case "moveDocument":
      return {
        folderIds: [],
        documentIds: batchTargets(input.documentIds, input.documentId),
      };
    case "renameFolder":
    case "describeFolder":
      return {
        folderIds: input.folderId ? [input.folderId] : [],
        documentIds: [],
      };
    case "renameDocument":
      return {
        folderIds: [],
        documentIds: input.documentId ? [input.documentId] : [],
      };
    default:
      // createFolder: a new folder has no id to act on yet.
      return { folderIds: [], documentIds: [] };
  }
};

/**
 * Domain tool (deferred) — organise the Drive tree through the validated
 * shared folder/document services, so path recomputation, subtree counts, and
 * the `domain_events` journal stay consistent. Reads go through `listFolders` /
 * `listDocuments`; saving an attachment goes through `uploadToDrive`.
 *
 * **Moves and deletes take LISTS.** One document per call made tidying a
 * Drive one agent step per document, and a turn has 30 steps: asked to sort
 * 762 documents, the agent filed 30 and stopped. One call is now one policy
 * decision, one approval card and one grant for the whole set, with a per-item
 * outcome so one stale id costs its own row, not the batch.
 */
export const createManageDriveTool = () =>
  tool({
    description: [
      "Organise the Drive: folders and where documents live. Journaled and team-scoped.",
      "",
      "- createFolder: name (+ optional parentFolderId, description). Creates a folder; omit parentFolderId for the root.",
      "- renameFolder: folderId + name.",
      "- describeFolder: folderId + description. Files you or a workflow save to the Drive with no folder are then filed into the folder whose description fits.",
      "- moveFolder: folderIds + parentFolderId (new parent; null = root).",
      "- deleteFolder: folderIds. Deletes the folders AND their documents/subfolders — confirm with the user first.",
      "- moveDocument: documentIds + parentFolderId (destination; null = root).",
      "- renameDocument: documentId + name. The file type is kept whatever you send, so name it as a title.",
      "",
      `Moves and deletes take lists: group everything bound for one destination into ONE call (max ${MAX_DOCUMENTS_PER_CALL.toString()} documents / ${MAX_FOLDERS_PER_CALL.toString()} folders), never one call per item. Read \`failed\` before reporting.`,
      "",
      "Get folder ids from `listFolders`, document ids from `listDocuments`. To save a conversation attachment into the Drive, use `uploadToDrive`; to change what a document SAYS, use `manageDocument`.",
    ].join("\n"),
    inputSchema: manageDriveInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const backstop = workflowWriteBackstop(ctx);
      if (backstop !== null) return backstop;
      const actor = agentEventActor(ctx);
      const targets = resolveTargets(input);

      try {
        // Batch shape before anything else. The schema caps each list, but a
        // stray singular id rides on top of it, and an empty list is a call
        // with nothing to do.
        if (input.action === "moveDocument") {
          if (targets.documentIds.length === 0) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "moveDocument requires documentIds.",
            );
          }
          if (targets.documentIds.length > MAX_DOCUMENTS_PER_CALL) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              `moveDocument takes at most ${MAX_DOCUMENTS_PER_CALL.toString()} documents per call.`,
              "Split the list into several calls.",
            );
          }
        }
        if (input.action === "moveFolder" || input.action === "deleteFolder") {
          if (targets.folderIds.length === 0) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              `${input.action} requires folderIds.`,
            );
          }
          if (targets.folderIds.length > MAX_FOLDERS_PER_CALL) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              `${input.action} takes at most ${MAX_FOLDERS_PER_CALL.toString()} folders per call.`,
              "Split the list into several calls.",
            );
          }
        }

        // Destination check BEFORE the gate: an approval must never be opened
        // for a write that cannot run, and every item of a batch move would
        // fail the same way on an unknown destination.
        if (
          (input.action === "moveDocument" || input.action === "moveFolder") &&
          input.parentFolderId
        ) {
          const dest = await resolveFolder(input.parentFolderId, ctx.teamId);
          if (!dest) {
            return toolError(
              TOOL_ERROR_CODES.NOT_FOUND,
              `Folder ${input.parentFolderId} not found for this team.`,
              "List folders with `listFolders` to get a valid id.",
            );
          }
        }

        // A delete only proposes the folders that exist: the ones that do not
        // are reported, and a human is never asked to approve deleting them.
        // `deleteFolders` itself is all-or-nothing on an unknown id.
        let deleteFailed: { folderId: string; reason: string }[] = [];
        if (input.action === "deleteFolder") {
          const existing = await db.query.folders.findMany({
            columns: { id: true },
            where: { id: { in: targets.folderIds }, teamId: ctx.teamId },
          });
          const found = new Set(existing.map((f) => f.id));
          deleteFailed = targets.folderIds
            .filter((id) => !found.has(id))
            .map((folderId) => ({ folderId, reason: "not_found" }));
          targets.folderIds = targets.folderIds.filter((id) => found.has(id));
          if (targets.folderIds.length === 0) {
            return toolError(
              TOOL_ERROR_CODES.NOT_FOUND,
              "None of these folders exists for this team.",
              "List folders with `listFolders` to get valid ids.",
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
            ? await driveSummaryFields(input, targets, ctx.teamId)
            : undefined;
        const batch =
          input.action === "moveDocument"
            ? { documentIds: targets.documentIds }
            : input.action === "moveFolder" || input.action === "deleteFolder"
              ? { folderIds: targets.folderIds }
              : { folderId: input.folderId, documentId: input.documentId };
        const gate = await gateBuiltinWriteTool(ctx, {
          toolName: "manageDrive",
          args: {
            action: input.action,
            name: input.name,
            ...batch,
            parentFolderId: input.parentFolderId ?? null,
            description: input.description,
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
            ...(input.description
              ? { description: { text: input.description, source: "agent" } }
              : {}),
          });
          return {
            ok: true,
            action: input.action,
            folder: {
              id: folder.id,
              name: folder.name,
              parentFolderId: folder.parentFolderId,
              description: folder.description,
            },
          };
        }

        if (input.action === "describeFolder") {
          if (!input.folderId || input.description === undefined) {
            return toolError(
              TOOL_ERROR_CODES.DRIVE_ERROR,
              "describeFolder requires folderId and description.",
            );
          }
          // Through the same service as the folder page, so the agent's
          // sentence obeys the same rules as a person's.
          const folder = await updateFolder({
            id: input.folderId,
            teamId: ctx.teamId,
            updates: { description: input.description },
            actor,
            descriptionSource: "agent",
          });
          return {
            ok: true,
            action: input.action,
            folder: {
              id: folder.id,
              name: folder.name,
              description: folder.description,
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
          const { moved, failed } = await moveFolders({
            ids: targets.folderIds,
            teamId: ctx.teamId,
            parentFolderId: input.parentFolderId ?? null,
            actor,
          });
          const [only] = moved;
          return {
            ok: failed.length === 0,
            action: input.action,
            folders: moved,
            // The single-folder shape the chat card has always read.
            ...(moved.length === 1 && only ? { folder: only } : {}),
            failed,
            destinationFolder: await resolveFolder(
              input.parentFolderId,
              ctx.teamId,
            ),
          };
        }

        if (input.action === "deleteFolder") {
          await deleteFolders({
            ids: targets.folderIds,
            teamId: ctx.teamId,
            actor,
          });
          return {
            ok: deleteFailed.length === 0,
            action: input.action,
            deleted: true,
            deletedFolderIds: targets.folderIds,
            failed: deleteFailed,
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

        // moveDocument — destination already validated above, before the gate.
        const { moved, unchanged, failed } = await moveDocuments({
          ids: targets.documentIds,
          teamId: ctx.teamId,
          folderId: input.parentFolderId ?? null,
        });
        const [only] = moved;
        return {
          ok: failed.length === 0,
          action: input.action,
          // Counts, not the list: the agent sent the ids, and echoing 200
          // filenames back would cost thousands of tokens it never reads.
          moved: moved.length,
          alreadyThere: unchanged.length,
          ...(moved.length === 1 && only ? { document: only } : {}),
          failed,
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
