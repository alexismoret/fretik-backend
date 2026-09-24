import type { UserPrincipal } from "@fretik/shared/authz/principal";
import db from "@fretik/shared/db";
import { searchDocuments } from "@fretik/shared/services/documents/retrieve";

/**
 * The project part of a chat's persistent context: what the people of the
 * project wrote for the assistant, and the files the project holds.
 *
 * The instructions are the project's own (`projects.instructions`), written
 * by whoever may edit the project; every chat of the project follows them.
 * The files are listed rather than inlined: names, ids and folders, so the
 * assistant knows what exists before it searches, and reads one through its
 * usual tools. They are listed as the turn's context identity sees them: the
 * writer's when nobody else reads the chat, the project's agent's otherwise
 * (`actingPrincipal`), so a file kept to one person is never announced to
 * the others.
 */

/** Enough to know what exists; the rest is one `listDocuments` away. */
const MAX_LISTED_FILES = 40;

export interface ProjectContextArgs {
  projectId: string;
  teamId: string;
  /** Who the files are listed for. */
  principal: UserPrincipal;
}

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes.toString()} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
};

const listProjectFiles = async (args: ProjectContextArgs): Promise<string> => {
  const { documents, hasMore } = await searchDocuments({
    principal: args.principal,
    teamId: args.teamId,
    projectId: args.projectId,
    status: "ready",
    limit: MAX_LISTED_FILES,
  });
  if (documents.length === 0) return "";
  const lines = documents.map((document) => {
    const where = document.folder
      ? `, in folder "${document.folder.name}"`
      : "";
    return `- ${document.originalFilename} (${document.mimeType}, ${formatSize(document.fileSize)}${where}) · id \`${document.id}\``;
  });
  return [
    "### Project files",
    "Search inside one with `searchKnowledge` (`filters.sourceIds`), or download it with `downloadDriveDocument` to work on the original.",
    "",
    ...lines,
    ...(hasMore
      ? [
          "",
          `_Only the ${MAX_LISTED_FILES.toString()} most recent are listed: \`listDocuments\` with \`inProject: true\` finds the others._`,
        ]
      : []),
  ].join("\n");
};

/**
 * `## Project: <name>`, with its description, instructions and files; empty
 * when the project is gone.
 */
export const buildProjectContextSection = async (
  args: ProjectContextArgs,
): Promise<string> => {
  const [project, files] = await Promise.all([
    db.query.projects.findFirst({
      where: { id: args.projectId },
      columns: { name: true, description: true, instructions: true },
    }),
    listProjectFiles(args),
  ]);
  if (!project) return "";

  const parts = [`## Project: ${project.name}`];
  const description = project.description.trim();
  if (description.length > 0) parts.push(description);
  const instructions = project.instructions.trim();
  if (instructions.length > 0) {
    parts.push(`### Project instructions\n${instructions}`);
  }
  if (files.length > 0) parts.push(files);
  return parts.join("\n\n");
};
