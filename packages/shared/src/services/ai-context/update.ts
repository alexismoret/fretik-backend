import { eq } from "drizzle-orm";
import db from "../../db";
import {
  aiContextFiles,
  aiContextProfiles,
  type AiContextProfile,
} from "../../db/schema/ai-context";
import { notFound, throwHttpError } from "../../lib/errors";
import { findContextProfile, type ScopeKey } from "./retrieve";

/**
 * Create or update the instructions on a user / team context
 * profile. Lazy-upserts the row so neither the UI nor the API
 * need to pre-create anything before the first save.
 *
 * `updatedById` is the user performing the change — for team scope
 * this is surfaced in the UI so team members can see who last
 * touched the shared instructions.
 */
export const upsertContextInstructions = async (args: {
  scope: ScopeKey;
  instructions: string;
}): Promise<AiContextProfile> => {
  const existing = await findContextProfile(args.scope);

  if (existing) {
    const [updated] = await db
      .update(aiContextProfiles)
      .set({
        instructions: args.instructions,
        updatedById: args.scope.userId,
      })
      .where(eq(aiContextProfiles.id, existing.id))
      .returning();
    if (!updated) {
      return throwHttpError(500, {
        code: "INTERNAL_ERROR",
        message: "Failed to update context profile",
      });
    }
    return updated;
  }

  const [created] = await db
    .insert(aiContextProfiles)
    .values({
      scope: args.scope.scope,
      organizationId: args.scope.organizationId,
      teamId: args.scope.scope === "team" ? args.scope.teamId : null,
      userId: args.scope.scope === "user" ? args.scope.userId : null,
      instructions: args.instructions,
      updatedById: args.scope.userId,
    })
    .returning();
  if (!created) {
    return throwHttpError(500, {
      code: "INTERNAL_ERROR",
      message: "Failed to create context profile",
    });
  }
  return created;
};

/**
 * Team-wide (or personal at user scope) toggle. Flipping it to
 * `false` removes the file from EVERYBODY's context on the profile
 * — distinct from per-user mutes which only affect the current
 * user (see `mutes.ts`).
 */
export const setContextFileEnabled = async (args: {
  fileId: string;
  organizationId: string;
  enabled: boolean;
}): Promise<void> => {
  const file = await db.query.aiContextFiles.findFirst({
    where: {
      id: args.fileId,
      organizationId: args.organizationId,
    },
    columns: { id: true },
  });
  if (!file) {
    return throwHttpError(404, notFound("Context file not found"));
  }

  await db
    .update(aiContextFiles)
    .set({ enabled: args.enabled })
    .where(eq(aiContextFiles.id, args.fileId));
};
