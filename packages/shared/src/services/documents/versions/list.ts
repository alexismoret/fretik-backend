import db from "../../../db";
import type { DocumentVersion } from "../../../db/schema/documents";
import { notFound, throwHttpError } from "../../../lib/errors";
import { getCurrentVersion } from "./record";

/**
 * A document's history, newest first — with who made each version.
 *
 * Materialises v1 on the way (via `getCurrentVersion`) so a document that
 * predates versioning shows a one-entry history rather than an empty panel
 * that reads like a bug.
 */

/**
 * How a version came about — the distinction a reader actually needs.
 *
 * `byActor` alone is too coarse. An assistant write inside someone's
 * conversation was still asked for by that person (and often approved by them),
 * so crediting "the agent" misattributes it, while showing only their name
 * hides that they did not type it. `manual` and `assistant` therefore BOTH
 * carry a person; only `workflow` may have nobody behind it, which is precisely
 * what makes it worth separating.
 *
 * Derived, not stored: the conversation's `agentType` already separates a chat
 * from a workflow run. `byConversationId` alone would NOT — a workflow run
 * carries a conversation too.
 */
export type DocumentVersionOrigin = "manual" | "assistant" | "workflow";

export interface DocumentVersionEntry extends DocumentVersion {
  /**
   * The person behind this version. Falls back to the conversation's owner, so
   * an assistant write always names who asked for it even if the version row
   * itself carries no user.
   */
  byUserName: string | null;
  origin: DocumentVersionOrigin;
  /** True for the version whose bytes are the document's live content. */
  isCurrent: boolean;
}

export const listDocumentVersions = async (args: {
  documentId: string;
  teamId: string;
}): Promise<DocumentVersionEntry[]> => {
  const document = await db.query.documents.findFirst({
    where: { id: args.documentId, teamId: args.teamId },
  });
  if (!document) {
    return throwHttpError(404, notFound("Document not found"));
  }

  await getCurrentVersion(document);

  const rows = await db.query.documentVersions.findMany({
    where: { documentId: args.documentId, teamId: args.teamId },
    orderBy: { versionNumber: "desc" },
    with: {
      byUser: { columns: { name: true } },
      byConversation: {
        columns: { agentType: true },
        with: { user: { columns: { name: true } } },
      },
    },
  });

  return rows.map((row, index) => ({
    ...row,
    byUserName: row.byUser?.name ?? row.byConversation?.user?.name ?? null,
    origin:
      row.byActor !== "agent"
        ? "manual"
        : row.byConversation?.agentType === "workflow"
          ? "workflow"
          : "assistant",
    isCurrent: index === 0,
  }));
};
