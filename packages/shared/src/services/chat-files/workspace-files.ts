import { and, desc, eq, ne } from "drizzle-orm";
import db from "../../db";
import { aiChatFiles, documents, documentVersions } from "../../db/schema";
import { mimeFromFilename } from "../../file-types";
import {
  listSessionEntries,
  readSessionFile,
} from "../../lib/chatbot-session-storage";
import { listPresentedFiles } from "./presented-files";

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

/**
 * Whether the agent handed this file over (`presentFiles`) or merely left
 * it behind. See `presented-files.ts` for why the transcript is what
 * answers this.
 */
export type WorkspaceFileKind = "deliverable" | "working";

export interface WorkspaceFile {
  source: WorkspaceFileSource;
  /**
   * Deliverable vs working-out. Attachments are always `deliverable`:
   * the user chose to put them here, so nothing about them is a
   * by-product.
   */
  kind: WorkspaceFileKind;
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
 * Session sub-trees that are never a file in their own right.
 *
 * `outputs/persisted/` is where an oversized tool result is parked so the
 * model can read it back (`maybePersistLargeOutput`). Those files are part of
 * how a turn works, not something anyone asked for — listing them buries the
 * one spreadsheet the user wanted under four `call_function_….json`.
 *
 * `attachments/` is listed from the `ai_chat_files` rows above, which carry
 * the detected MIME and the Drive link the S3 listing knows nothing about;
 * taking it from both would double every attachment. `previews/` holds PDF
 * renditions of files already listed — a derived artefact of a row, not a
 * row.
 *
 * Spelled out here rather than imported: the constants live in
 * `@fretik/ai/lib/conversation-storage` (`WORKSPACE_DIRS`) and this package
 * cannot depend on that one. Keep the two in step.
 */
const EXCLUDED_SESSION_PREFIXES = [
  "outputs/persisted/",
  "attachments/",
  "previews/",
] as const;

/**
 * `outputs/` is where the agent is told to put what it produces, and it is
 * mirrored to S3 after every sandbox run — so those files still have bytes
 * once the sandbox is paused.
 *
 * It is not the only place a deliverable can be, though, which is what the
 * `presented` set below is for: `presentFiles` accepts any path under
 * `/workspace/` and mirrors whatever it is given, so an agent that wrote to
 * the workspace root and presented it produced a file with real bytes on S3
 * that this listing used to ignore completely. It was uploaded, it was
 * announced to the user, and the panel showed nothing.
 */
const PRIMARY_OUTPUT_PREFIX = "outputs/";

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
    kind: "deliverable",
    path: `attachments/${row.filename}`,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt,
    driveDocumentId: row.documentId,
  }));

  // The whole session tree in one listing, rather than one call per known
  // directory: a presented file can be anywhere under the workspace, and
  // asking S3 per directory cannot find what it was not told to look for.
  const [sessionEntries, presented] = await Promise.all([
    listSessionEntries(args.conversationId),
    listPresentedFiles(args.conversationId),
  ]);

  // Documents this conversation has already filed, by name. ONE query and no
  // byte reads — which is the whole point: it answers "is there a document
  // from this conversation under this name" for the entire list at once.
  //
  // It deliberately stops short of the precise answer. Whether the bytes on
  // disk still MATCH that document needs a hash, so it is left to
  // `resolveDriveState`, asked per file when one is actually opened.
  const filedHere = await documentsFiledFromConversation(args);

  /**
   * Only split the outputs when there is positive evidence to split them
   * on. A conversation where the agent never called `presentFiles` has no
   * deliverables recorded, and treating that as "everything here is
   * working-out" would fold the whole panel into a secondary section —
   * hiding files on the strength of a signal that was never sent.
   *
   * So: no presented file anywhere, no demotion. Silence is not evidence.
   */
  const splittable = presented.size > 0;

  const kindOf = (path: string): WorkspaceFileKind =>
    !splittable || presented.has(path) ? "deliverable" : "working";

  const outputs: WorkspaceFile[] = sessionEntries
    .filter((entry) => {
      if (
        EXCLUDED_SESSION_PREFIXES.some((prefix) =>
          entry.path.startsWith(prefix),
        )
      ) {
        return false;
      }
      return (
        entry.path.startsWith(PRIMARY_OUTPUT_PREFIX) ||
        presented.has(entry.path)
      );
    })
    .map((entry) => {
      const filename = entry.path.split("/").pop() ?? entry.path;
      return {
        source: "output" as const,
        kind: kindOf(entry.path),
        path: entry.path,
        filename,
        // Best effort from the NAME, which is all a sandbox output has —
        // sniffing the real type would mean reading every object to render
        // a list.
        //
        // `mimeFromFilename`, not `declaredMimeFromFilename`: the latter
        // covers TEXTUAL types only, so it answered `application/octet-stream`
        // for every PNG, XLSX and PDF the agent produced, and the frontend
        // carried a repair step to undo exactly that. An extension nobody
        // has catalogued still lands on `octet-stream` — the viewer settles
        // that one from the bytes it downloads anyway.
        mimeType: mimeFromFilename(filename),
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
