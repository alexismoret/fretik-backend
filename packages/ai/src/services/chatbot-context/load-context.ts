import db from "@fretik/shared/db";
import {
  aiContextFiles,
  aiContextProfiles,
  aiContextUserFileMutes,
  aiContextUserProfileMutes,
  type AiContextFile,
} from "@fretik/shared/db/schema";
import { and, eq, inArray, or } from "drizzle-orm";

/**
 * Shared loader for the persistent chatbot context. Used by:
 *
 *  - `build-manifest.ts` — to render the system-prompt manifest of
 *    accessible files (filename + outline + preview + id) and the
 *    user/team instructions.
 *  - `read-context-file.ts` — to ACL-check a `file_id` the model
 *    asked to read and return its row + content.
 *
 * Resolution rules:
 *  - Load both the user and team profiles in one query, partitioned
 *    client-side by `scope`.
 *  - Per-user file mutes (`aiContextUserFileMutes`) exclude individual
 *    team files for this user only.
 *  - Per-user profile mutes (`aiContextUserProfileMutes`) suppress the
 *    team profile's INSTRUCTIONS only — the team's files stay
 *    accessible (matches the prior renderer's semantics).
 *  - User-scope resources are never muted (you can't mute your own
 *    context — toggle `enabled` or delete instead).
 *  - `enabled = false` is a global opt-out applied at render time, not
 *    here, so the ACL stays "can this user reach this row at all".
 */

export type ContextFileScope = "user" | "team";

export interface AccessibleContextFile extends AiContextFile {
  /** Resolved from the file's profile.scope at load time. */
  scope: ContextFileScope;
}

export interface LoadedContext {
  userProfile: { id: string; instructions: string } | null;
  teamProfile: {
    id: string;
    instructions: string;
    /** True when the user has muted the team profile (instructions hidden). */
    instructionsMuted: boolean;
  } | null;
  /**
   * Files this user can reach. Per-user file mutes are already
   * applied; `enabled` and `status` are NOT filtered — the manifest
   * builder applies its own visibility rules and the read tool needs
   * to surface a clear NOT_READY error when status is transient.
   */
  files: AccessibleContextFile[];
}

export interface LoadContextArgs {
  userId: string | undefined;
  teamId: string;
  organizationId: string;
}

export const loadAccessibleContext = async (
  args: LoadContextArgs,
): Promise<LoadedContext> => {
  const profileRows = await db
    .select()
    .from(aiContextProfiles)
    .where(
      and(
        eq(aiContextProfiles.organizationId, args.organizationId),
        or(
          args.userId
            ? and(
                eq(aiContextProfiles.scope, "user"),
                eq(aiContextProfiles.userId, args.userId),
              )
            : undefined,
          and(
            eq(aiContextProfiles.scope, "team"),
            eq(aiContextProfiles.teamId, args.teamId),
          ),
        ),
      ),
    );

  if (profileRows.length === 0) {
    return { userProfile: null, teamProfile: null, files: [] };
  }

  const profileIds = profileRows.map((p) => p.id);

  const [files, fileMutes, profileMutes] = await Promise.all([
    db
      .select()
      .from(aiContextFiles)
      .where(inArray(aiContextFiles.profileId, profileIds)),
    args.userId
      ? db
          .select({ fileId: aiContextUserFileMutes.fileId })
          .from(aiContextUserFileMutes)
          .where(eq(aiContextUserFileMutes.userId, args.userId))
      : Promise.resolve([]),
    args.userId
      ? db
          .select({ profileId: aiContextUserProfileMutes.profileId })
          .from(aiContextUserProfileMutes)
          .where(eq(aiContextUserProfileMutes.userId, args.userId))
      : Promise.resolve([]),
  ]);

  const mutedFileIds = new Set(fileMutes.map((r) => r.fileId));
  const mutedProfileIds = new Set(profileMutes.map((r) => r.profileId));

  const teamRow = profileRows.find((p) => p.scope === "team");
  const userRow = profileRows.find((p) => p.scope === "user");

  const teamProfile = teamRow
    ? {
        id: teamRow.id,
        instructions: teamRow.instructions,
        instructionsMuted: mutedProfileIds.has(teamRow.id),
      }
    : null;

  const userProfile = userRow
    ? { id: userRow.id, instructions: userRow.instructions }
    : null;

  const accessibleFiles: AccessibleContextFile[] = [];
  for (const file of files) {
    if (mutedFileIds.has(file.id)) continue;
    const scope: ContextFileScope =
      teamRow !== undefined && file.profileId === teamRow.id ? "team" : "user";
    accessibleFiles.push({ ...file, scope });
  }

  return { userProfile, teamProfile, files: accessibleFiles };
};
