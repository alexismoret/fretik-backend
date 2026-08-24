import { and, desc, eq, ne } from "drizzle-orm";
import db from "../../db";
import { aiChatFiles, documents, documentVersions } from "../../db/schema";
import { declaredMimeFromFilename } from "../../file-types";
import {
  listSessionEntries,
  readSessionFile,
} from "../../lib/chatbot-session-storage";

/**
 * Everything a conversation has produced or been given, as one list.
 *
 * A conversation holds files from two places that have nothing in common
 * structurally, and the reader does not care about the difference:
 *
 *  - ATTACHMENTS the user sent, which are rows in `ai_chat_files` and carry
 *    their own `documentId` once promoted;
 *  - OUTPUTS the agent wrote, which have no row anywhere. They are S3 objects
 *    under the conversation's session prefix and nothing more, so their name,
 *    size and date come from the listing itself.
 *
 * That asymmetry is why "is this already in the Drive?" is answered by a
 * separate call (`resolveDriveState`) rather than inlined here: for an
 * attachment it is a column, for an output it costs reading and hashing the
 * bytes. Answering it for every file on every panel open would download the
 * whole workspace to render a list.
 */

export type WorkspaceFileSource = "attachment" | "output";

export interface WorkspaceFile {
  source: WorkspaceFileSource;
  /** Session-relative for outputs (`outputs/report.xlsx`), bare for attachments. */
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date | null;
  /**
   * Known WITHOUT hashing — an attachment row records where it was promoted.
   * Always null for an output; ask `resolveDriveState` for those.
   */
  driveDocumentId: string | null;
}

/**
 * `outputs/` is mirrored to S3 after a sandbox run, so its files still have
 * bytes once the sandbox is paused, and it is where the agent puts what it
 * MEANT to hand over. `attachments/` comes from the rows above instead;
 * `skills/`, `runs/` and the rest are machinery, not deliverables.
 */
const LISTED_OUTPUT_DIRS = ["outputs"] as const;

/**
 * Sub-trees of `outputs/` that are MACHINERY, not deliverables.
 *
 * `outputs/persisted/` is where an oversized tool result is parked so the
 * model can read it back (`maybePersistLargeOutput`). Those files are part of
 * how a turn works, not something anyone asked for — listing them buries the
 * one spreadsheet the user wanted under four `call_function_….json`.
 *
 * Spelled out here rather than imported: the constant lives in
 * `@fretik/ai/lib/conversation-storage` (`WORKSPACE_DIRS.outputsPersisted`)
 * and this package cannot depend on that one. Keep the two in step.
 */
const EXCLUDED_OUTPUT_PREFIXES = ["outputs/persisted/"] as const;

/**
 * Documents this conversation put in the Drive, keyed by filename.
 *
 * `document_versions.byConversationId` is the link — recorded when a file is
 * promoted, which is why the promotion path writes v1 itself instead of
 * letting it be back-filled later without one.
 */
const documentsFiledFromConversation = async (args: {
  conversationId: string;
  teamId: string;
}): Promise<Map<string, string>> => {
  const rows = await db
    .selectDistinct({
      documentId: documents.id,
      filename: documents.originalFilename,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documents.teamId, args.teamId),
        eq(documentVersions.byConversationId, args.conversationId),
      ),
    );
  return new Map(rows.map((row) => [row.filename, row.documentId]));
};

export const listConversationWorkspaceFiles = async (args: {
  conversationId: string;
  teamId: string;
}): Promise<WorkspaceFile[]> => {
  const attachmentRows = await db
    .select({
      filename: aiChatFiles.filename,
      mimeType: aiChatFiles.mimeType,
      size: aiChatFiles.size,
      documentId: aiChatFiles.documentId,
      createdAt: aiChatFiles.createdAt,
    })
    .from(aiChatFiles)
    .where(
      and(
        eq(aiChatFiles.conversationId, args.conversationId),
        ne(aiChatFiles.status, "error"),
      ),
    )
    .orderBy(desc(aiChatFiles.createdAt));

  const attachments: WorkspaceFile[] = attachmentRows.map((row) => ({
    source: "attachment",
    path: `attachments/${row.filename}`,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    driveDocumentId: row.documentId,
  }));

  const outputLists = await Promise.all(
    LISTED_OUTPUT_DIRS.map((dir) =>
      listSessionEntries(args.conversationId, dir),
    ),
  );

  // Documents this conversation has already filed, by name. ONE query and no
  // byte reads — which is the whole point: it answers "is there a document
  // from this conversation under this name" for the entire list at once.
  //
  // It deliberately stops short of the precise answer. Whether the bytes on
  // disk still MATCH that document needs a hash, so it is left to
  // `resolveDriveState`, asked per file when one is actually opened.
  const filedHere = await documentsFiledFromConversation(args);

  const outputs: WorkspaceFile[] = outputLists
    .flat()
    .filter(
      (entry) =>
        !EXCLUDED_OUTPUT_PREFIXES.some((prefix) =>
          entry.path.startsWith(prefix),
        ),
    )
    .map((entry) => {
      const filename = entry.path.split("/").pop() ?? entry.path;
      return {
        source: "output" as const,
        path: entry.path,
        filename,
        // Best effort only, and it covers text formats alone — the viewer
        // types a file from its NAME, which is all a sandbox output has.
        // Sniffing the real type would mean reading every object.
        mimeType:
          declaredMimeFromFilename(filename) ?? "application/octet-stream",
        size: entry.size,
        createdAt: entry.lastModified,
        driveDocumentId: filedHere.get(filename) ?? null,
      };
    });

  // Newest first across both families — the deliverable someone just asked
  // about is the one they want at the front.
  return [...outputs, ...attachments].sort((a, b) => {
    const left = a.createdAt?.getTime() ?? 0;
    const right = b.createdAt?.getTime() ?? 0;
    return right - left;
  });
};

/**
 * Whether one workspace file is in the Drive, and if not, whether it SUPERSEDES
 * something that is.
 *
 * The third state is the one that matters. An agent that fixes a spreadsheet
 * and regenerates it produces bytes that hash differently from the copy already
 * filed, so a plain "is this hash in the Drive?" says "no" and the obvious
 * button files a SECOND document with the same name and no relation to the
 * first. The Drive then holds two `report.xlsx` and no way to tell which is
 * current — precisely what versioning exists to prevent.
 *
 * The link that makes the difference detectable is `byConversationId` on the
 * version rows: a document this conversation already produced, under this
 * name, is what these new bytes are a new version OF.
 */
export type DriveState =
  /** Not in the Drive, and nothing here it would supersede. */
  | { state: "absent" }
  /** These exact bytes are already filed. */
  | { state: "present"; documentId: string; filename: string }
  /** A newer take on a document this conversation already filed. */
  | { state: "supersedes"; documentId: string; filename: string };

export const resolveDriveState = async (args: {
  conversationId: string;
  teamId: string;
  path: string;
}): Promise<DriveState> => {
  const bytes = await readSessionFile(args.conversationId, args.path);
  if (!bytes || bytes.length === 0) return { state: "absent" };

  const fileHash = Bun.SHA256.hash(bytes, "hex");
  const identical = await db.query.documents.findFirst({
    columns: { id: true, originalFilename: true },
    where: { teamId: args.teamId, fileHash },
  });
  if (identical) {
    return {
      state: "present",
      documentId: identical.id,
      filename: identical.originalFilename,
    };
  }

  // Same name, filed from THIS conversation: the earlier take on the same
  // deliverable. Scoped to the conversation rather than the team so two
  // unrelated `report.xlsx` never get chained into one another's history.
  const filename = args.path.split("/").pop() ?? args.path;
  const producedHere = await db
    .selectDistinct({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.teamId, args.teamId),
        eq(documentVersions.byConversationId, args.conversationId),
      ),
    );
  if (producedHere.length === 0) return { state: "absent" };

  const previous = await db.query.documents.findFirst({
    columns: { id: true, originalFilename: true },
    where: {
      teamId: args.teamId,
      originalFilename: filename,
      id: {
        in: producedHere
          .map((row) => row.documentId)
          .filter((id): id is string => id !== null),
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (previous) {
    return {
      state: "supersedes",
      documentId: previous.id,
      filename: previous.originalFilename,
    };
  }

  return { state: "absent" };
};
