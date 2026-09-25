import type { EventActor } from "../domain-events/emit";
import { updateFolder } from "./update";

export interface MoveFoldersResult {
  moved: { id: string; name: string }[];
  failed: { folderId: string; reason: string }[];
}

/**
 * The readable half of a service error. `throwHttpError` carries its
 * `{ code, message }` as a JSON string, which is noise in a per-item report
 * the agent reads back to a person.
 */
const reasonOf = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    // Not JSON: already a plain message.
  }
  return raw;
};

/**
 * Move several folders under one parent (`null` = the Drive root), each with
 * its own outcome.
 *
 * A loop over `updateFolder`, on purpose, and the exception to the set-based
 * rule: a folder move rewrites the `fullPath` of its whole subtree and checks
 * that the folder is not being put inside itself, both per folder, and the
 * callers cap a call at a few dozen folders. What this adds over calling it
 * N times is the contract a batch needs: one bad folder is reported, not
 * thrown, so it cannot cost the others.
 */
export const moveFolders = async (params: {
  ids: readonly string[];
  teamId: string;
  parentFolderId: string | null;
  actor?: EventActor;
}): Promise<MoveFoldersResult> => {
  const moved: MoveFoldersResult["moved"] = [];
  const failed: MoveFoldersResult["failed"] = [];
  for (const id of new Set(params.ids)) {
    try {
      // One transaction per folder, so one failure cannot roll back the rest.
      // eslint-disable-next-line no-await-in-loop
      const folder = await updateFolder({
        id,
        teamId: params.teamId,
        updates: { parentFolderId: params.parentFolderId },
        ...(params.actor ? { actor: params.actor } : {}),
      });
      moved.push({ id: folder.id, name: folder.name });
    } catch (error) {
      failed.push({ folderId: id, reason: reasonOf(error) });
    }
  }
  return { moved, failed };
};
