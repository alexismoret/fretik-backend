import { listFolders } from "@fretik/shared/services/folders/list";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `listFolders` — list a folder's direct sub-folders so the agent can discover
 * folder ids for `manageDrive` (rename / move / delete) or `uploadToDrive`,
 * including empty folders that never surface through `listDocuments`. The read
 * companion to `listDocuments` over the Drive tree.
 */
export const createListFoldersTool = () =>
  tool({
    description: [
      "List the sub-folders of a Drive folder (or the root). Use to discover folder ids for `manageDrive` / `uploadToDrive`, including empty folders that `listDocuments` never shows.",
      "",
      "Inputs:",
      "- parentFolderId (optional): folder to list inside. Omit or null for the Drive root.",
      "",
      "Output: { folders: [{ id, name, subFolderCount, documentCount }], parentFolderId }. Recurse by passing a returned id back as parentFolderId.",
    ].join("\n"),
    inputSchema: z.object({
      parentFolderId: z
        .string()
        .uuid()
        .nullish()
        .describe("Folder id to list inside. Omit or null for the Drive root."),
    }),
    execute: async ({ parentFolderId }, options) => {
      const ctx = getRuntimeContext(options);
      try {
        const folders = await listFolders({
          teamId: ctx.teamId,
          parentFolderId: parentFolderId ?? null,
        });
        return {
          folders: folders.map((f) => ({
            id: f.id,
            name: f.name,
            subFolderCount: f.subFolderCount,
            documentCount: f.documentCount,
          })),
          parentFolderId: parentFolderId ?? null,
        };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.DRIVE_ERROR,
          `listFolders failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });
