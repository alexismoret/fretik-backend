import { applyTextEdits } from "@fretik/shared/lib/text-edits";
import { parseApiError } from "@fretik/shared/schemas/errors";
import {
  getAuthoredContent,
  saveAuthoredContent,
} from "@fretik/shared/services/documents/authored/content";
import { createAuthoredDocument } from "@fretik/shared/services/documents/authored/create";
import { listDocumentVersions } from "@fretik/shared/services/documents/versions/list";
import { restoreDocumentVersion } from "@fretik/shared/services/documents/versions/restore";
import { tool } from "ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { gateBuiltinWriteTool } from "../agents/shared/policy-tool-gate";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import { workflowWriteBackstop } from "../agents/shared/workflow-write-backstop";
import {
  TOOL_ERROR_CODES,
  toolError,
  type ToolErrorOutput,
} from "../lib/tool-error-codes";

/**
 * `manageDocument` — write and revise what a Drive document SAYS.
 *
 * Boundary with `manageDrive`, stated once so neither description has to argue
 * it: `manageDrive` owns where a document lives and what it is called,
 * `manageDocument` owns what it contains and how it changed. Same split the UI
 * has (the explorer's context menu vs opening the document). Nothing here
 * duplicates another tool — listing is `listDocuments`, uploading is
 * `uploadToDrive`, filing is `manageDrive`.
 *
 * `get` is not a convenience. It returns the live content WITH its `revision`,
 * and `update` requires that revision back — the read-before-write contract.
 * Without it an edit anchors on text that may already be gone, the failure mode
 * Claude Code's Edit tool guards with "File has been modified since read".
 * Reading a downloaded copy out of the sandbox cannot serve: it carries no
 * revision and drifts from the live document.
 *
 * History and restore apply to EVERY document, not just written ones — an
 * uploaded PDF that was replaced has the same history and the same rollback.
 */

/** Ceiling on a document's markdown, mirroring the API boundary's. */
const MAX_CONTENT_CHARS = 512 * 1024;

const documentEditSchema = z.object({
  oldString: z
    .string()
    .min(1)
    .describe("Exact text to replace, copied verbatim from `get`."),
  newString: z.string().describe("Replacement text. Empty string deletes."),
  replaceAll: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match."),
});

/** Services throw `HTTPException`; the agent reads an envelope. */
const liftDocumentError = (
  err: unknown,
  ctx: { action: string; documentId?: string },
): ToolErrorOutput | null => {
  if (!(err instanceof HTTPException)) return null;
  const parsed = parseApiError(err.message);
  const message = parsed?.message;

  if (err.status === 404) {
    return toolError(
      TOOL_ERROR_CODES.NOT_FOUND,
      message ??
        `No document ${ctx.documentId ?? "with that id"} in this team's Drive.`,
      `Find it with listDocuments, then retry ${ctx.action}.`,
    );
  }
  if (err.status === 409) {
    return toolError(
      TOOL_ERROR_CODES.DOCUMENT_STALE,
      message ?? "The document changed since you read it.",
      'Call { action: "get" } again and rebuild your edits from the text it returns.',
    );
  }
  if (err.status === 400) {
    return toolError(
      TOOL_ERROR_CODES.INVALID_ARGS,
      message ?? "The document rejected this operation.",
      parsed?.code === "DOCUMENT_NOT_AUTHORED"
        ? "Only text documents are editable. Replace a PDF or spreadsheet by saving new bytes over it with `uploadToDrive`."
        : undefined,
    );
  }
  return null;
};

export const createManageDocumentTool = () =>
  tool({
    description: [
      "Write and revise documents in the team's Drive, and browse any document's version history. A written document is an ordinary Drive document — searchable, mentionable, shared with the team — so this is how a durable deliverable gets made, as opposed to a file that only exists in this conversation.",
      "",
      "When to use:",
      "- The user wants something written: a report, a note, a summary, a spec.",
      "- A document already exists and should be revised rather than duplicated.",
      "- The user asks what changed in a document, or wants an earlier version back.",
      "",
      "When NOT to use: the deliverable is a spreadsheet, a deck or a PDF — build it in your workspace and save it with `uploadToDrive`. Renaming, moving and filing are `manageDrive`.",
      "",
      "Actions:",
      "- get { documentId } → the markdown plus a `revision` stamp.",
      "- create { title, content, folderId? } → a new document, usable immediately.",
      "- update { documentId, revision, edits | content } → `edits` for targeted changes, `content` to replace the whole document.",
      "- history { documentId } → who changed it, when, and how — `origin` says whether a person edited it directly, an assistant did on their behalf, or an unattended workflow run did. Works for any document, uploaded files included.",
      "- restore { documentId, versionId } → brings a version back as the newest one. Nothing is lost; the rollback can itself be undone.",
      "",
      "Editing rules:",
      "- Call `get` first and send back its `revision`. A stale one is refused: your anchors were written against text that has since changed.",
      "- `oldString` must appear EXACTLY once, whitespace included. Several matches is refused rather than guessed — widen it, or set replaceAll.",
      "- Prefer `edits` over `content`: cheaper, and the user sees what changed.",
      "",
      "Output: { ok, documentId, title, revision, versionNumber } on a write; { content, revision } on get; a version list on history.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum(["get", "create", "update", "history", "restore"]),
      documentId: z
        .uuid()
        .optional()
        .describe("Target document, for every action but `create`."),
      title: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("create: the document's title, which becomes its filename."),
      content: z
        .string()
        .max(MAX_CONTENT_CHARS)
        .optional()
        .describe(
          "Markdown in full — the body on `create`, a whole-document replacement on `update`.",
        ),
      edits: z
        .array(documentEditSchema)
        .min(1)
        .optional()
        .describe("update: targeted replacements, applied in order."),
      revision: z
        .string()
        .optional()
        .describe(
          "update: the `revision` returned by the `get` these edits were written against.",
        ),
      folderId: z
        .uuid()
        .nullish()
        .describe("create: destination folder. Omit for the Drive root."),
      versionId: z
        .uuid()
        .optional()
        .describe("restore: the version to bring back, from `history`."),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      if (!ctx.userId) {
        return toolError(
          TOOL_ERROR_CODES.REQUIRES_USER,
          "manageDocument requires a signed-in user context.",
        );
      }
      const userId = ctx.userId;
      const actorContext = {
        actor: "agent" as const,
        userId,
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
      };
      const scope = { teamId: ctx.teamId, organizationId: ctx.organizationId };

      if (input.action !== "create" && !input.documentId) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `${input.action} needs a documentId.`,
          "Find it with listDocuments.",
        );
      }
      const documentId = input.documentId ?? "";

      try {
        if (input.action === "get") {
          const { document, content } = await getAuthoredContent({
            documentId,
            teamId: ctx.teamId,
          });
          return {
            ok: true,
            documentId: document.id,
            title: document.originalFilename,
            revision: document.fileHash,
            content,
          };
        }

        if (input.action === "history") {
          const versions = await listDocumentVersions({
            documentId,
            teamId: ctx.teamId,
          });
          return {
            ok: true,
            documentId,
            versions: versions.map((v) => ({
              versionId: v.id,
              versionNumber: v.versionNumber,
              change: v.operation,
              // Origin and person are different facts and both matter: your own
              // writes carry the person who asked for them, so a single field
              // would either credit them for text they never typed or hide who
              // it was for.
              origin: v.origin,
              by: v.byUserName,
              isCurrent: v.isCurrent,
              at: v.createdAt.toISOString(),
            })),
          };
        }

        const backstop = workflowWriteBackstop(ctx);
        if (backstop !== null) return backstop;

        if (input.action === "create") {
          if (!input.title) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "create needs a title.",
            );
          }
          const gate = await gateBuiltinWriteTool(ctx, {
            toolName: "manageDocument",
            args: {
              action: "create",
              title: input.title,
              content: input.content ?? "",
              folderId: input.folderId ?? null,
            },
          });
          if (gate !== null) return gate;

          const document = await createAuthoredDocument({
            ...scope,
            userId,
            title: input.title,
            content: input.content ?? "",
            folderId: input.folderId ?? null,
            actorContext,
            eventActor: {
              actorType: "agent",
              actorUserId: userId,
              ...(ctx.conversationId
                ? { conversationId: ctx.conversationId }
                : {}),
            },
          });
          return {
            ok: true,
            documentId: document.id,
            title: document.originalFilename,
            revision: document.fileHash,
            versionNumber: 1,
          };
        }

        if (input.action === "restore") {
          if (!input.versionId) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "restore needs a versionId.",
              'Call { action: "history" } to list them.',
            );
          }
          const gate = await gateBuiltinWriteTool(ctx, {
            toolName: "manageDocument",
            args: {
              action: "restore",
              documentId,
              versionId: input.versionId,
            },
          });
          if (gate !== null) return gate;

          const result = await restoreDocumentVersion({
            ...scope,
            documentId,
            versionId: input.versionId,
            actorContext,
          });
          return {
            ok: true,
            documentId: result.document.id,
            title: result.document.originalFilename,
            revision: result.document.fileHash,
            versionNumber: result.version.versionNumber,
            unchanged: result.unchanged,
          };
        }

        // update
        if (!input.edits && input.content === undefined) {
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            "update needs either `edits` or `content`.",
            "Prefer `edits` — it is cheaper and shows the user what changed.",
          );
        }
        if (!input.revision) {
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            "update needs the `revision` of the version you are editing.",
            'Call { action: "get" } first and send back the revision it returns.',
          );
        }

        let nextContent = input.content;
        if (input.edits) {
          const { document, content } = await getAuthoredContent({
            documentId,
            teamId: ctx.teamId,
          });
          // Check the revision BEFORE applying: an anchor can still match in a
          // document someone else rewrote, so a successful match is not proof
          // that the agent's view is current.
          if (document.fileHash !== input.revision) {
            return toolError(
              TOOL_ERROR_CODES.DOCUMENT_STALE,
              "The document changed since you read it.",
              'Call { action: "get" } again and rebuild your edits from the text it returns.',
            );
          }
          const edited = applyTextEdits(content, input.edits, {
            maxChars: MAX_CONTENT_CHARS,
            subject: "document",
            reanchorHint: 'Call { action: "get" } and re-anchor.',
          });
          if (!edited.ok) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              edited.error,
              "Nothing was saved.",
            );
          }
          nextContent = edited.text;
        }

        const gate = await gateBuiltinWriteTool(ctx, {
          toolName: "manageDocument",
          args: {
            action: "update",
            documentId,
            content: nextContent ?? "",
            revision: input.revision,
          },
        });
        if (gate !== null) return gate;

        const result = await saveAuthoredContent({
          ...scope,
          documentId,
          content: nextContent ?? "",
          actorContext,
          expectedFileHash: input.revision,
        });
        return {
          ok: true,
          documentId: result.document.id,
          title: result.document.originalFilename,
          revision: result.document.fileHash,
          versionNumber: result.version.versionNumber,
          unchanged: result.unchanged,
        };
      } catch (err) {
        const lifted = liftDocumentError(err, {
          action: input.action,
          ...(input.documentId ? { documentId: input.documentId } : {}),
        });
        if (lifted) return lifted;
        throw err;
      }
    },
  });
