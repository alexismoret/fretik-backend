import { and, eq } from "drizzle-orm";
import db from "../../db";
import {
  aiContextFiles,
  aiContextProfiles,
  aiContextUserFileMutes,
  aiContextUserProfileMutes,
} from "../../db/schema/ai-context";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * Per-user mute overrides for TEAM resources. Presence of a row =
 * muted for this user only; removing the row re-includes the team
 * resource in the user's context block on the next chatbot turn.
 *
 * We intentionally make mutes idempotent (upsert on set, no-op on
 * already-muted; DELETE IF EXISTS on unmute) so the UI can fire
 * optimistic toggles without guessing server state.
 */

const muteFileInsertValues = (userId: string, fileId: string) => ({
  userId,
  fileId,
});

const muteProfileInsertValues = (userId: string, profileId: string) => ({
  userId,
  profileId,
});

/**
 * Validate that a file belongs to the caller's organisation AND to a
 * team-scope profile (muting your own user-scope file is pointless —
 * just delete it or toggle `enabled`).
 */
const assertTeamFile = async (args: {
  fileId: string;
  organizationId: string;
}): Promise<void> => {
  const row = await db
    .select({
      profileScope: aiContextProfiles.scope,
    })
    .from(aiContextFiles)
    .innerJoin(
      aiContextProfiles,
      eq(aiContextFiles.profileId, aiContextProfiles.id),
    )
    .where(
      and(
        eq(aiContextFiles.id, args.fileId),
        eq(aiContextFiles.organizationId, args.organizationId),
      ),
    )
    .limit(1);

  const match = row[0];
  if (!match) {
    return throwHttpError(404, notFound("Context file not found"));
  }
  if (match.profileScope !== "team") {
    return throwHttpError(400, {
      code: "MUTE_NOT_ALLOWED",
      message:
        "Per-user mutes are only available for team-scope files. User-scope files should be toggled via `enabled` or deleted.",
    });
  }
};

export const setUserFileMute = async (args: {
  userId: string;
  fileId: string;
  organizationId: string;
  muted: boolean;
}): Promise<void> => {
  await assertTeamFile({
    fileId: args.fileId,
    organizationId: args.organizationId,
  });

  if (args.muted) {
    await db
      .insert(aiContextUserFileMutes)
      .values(muteFileInsertValues(args.userId, args.fileId))
      .onConflictDoNothing();
  } else {
    await db
      .delete(aiContextUserFileMutes)
      .where(
        and(
          eq(aiContextUserFileMutes.userId, args.userId),
          eq(aiContextUserFileMutes.fileId, args.fileId),
        ),
      );
  }
};

const assertTeamProfile = async (args: {
  profileId: string;
  organizationId: string;
}): Promise<void> => {
  const profile = await db.query.aiContextProfiles.findFirst({
    where: {
      id: args.profileId,
      organizationId: args.organizationId,
    },
    columns: { id: true, scope: true },
  });
  if (!profile) {
    return throwHttpError(404, notFound("Context profile not found"));
  }
  if (profile.scope !== "team") {
    return throwHttpError(400, {
      code: "MUTE_NOT_ALLOWED",
      message:
        "Per-user mutes on instructions are only available for team profiles.",
    });
  }
};

export const setUserProfileMute = async (args: {
  userId: string;
  profileId: string;
  organizationId: string;
  muted: boolean;
}): Promise<void> => {
  await assertTeamProfile({
    profileId: args.profileId,
    organizationId: args.organizationId,
  });

  if (args.muted) {
    await db
      .insert(aiContextUserProfileMutes)
      .values(muteProfileInsertValues(args.userId, args.profileId))
      .onConflictDoNothing();
  } else {
    await db
      .delete(aiContextUserProfileMutes)
      .where(
        and(
          eq(aiContextUserProfileMutes.userId, args.userId),
          eq(aiContextUserProfileMutes.profileId, args.profileId),
        ),
      );
  }
};
