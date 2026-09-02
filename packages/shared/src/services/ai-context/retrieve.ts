import { eq } from "drizzle-orm";
import db from "../../db";
import {
  aiContextFiles,
  aiContextUserFileMutes,
  type AiContextFile,
  type AiContextProfile,
  type AiContextScope,
} from "../../db/schema/ai-context";
import { notFound, throwHttpError } from "../../lib/errors";

/**
 * Shape returned by the API to the settings UI. Files are enriched
 * with a per-user `mutedByMe` boolean so the UI can render both the
 * team-wide `enabled` switch AND the user's personal override.
 */
export interface ContextFileSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  status: AiContextFile["status"];
  errorMessage: string | null;
  charCount: number | null;
  pageCount: number | null;
  enabled: boolean;
  mutedByMe: boolean;
  uploadedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextProfileSummary {
  id: string;
  scope: AiContextScope;
  instructions: string;
  mutedByMe: boolean;
  updatedById: string | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: Date;
}

export interface ContextProfileResponse {
  profile: ContextProfileSummary;
  files: ContextFileSummary[];
  totalCharCount: number;
  tokenEstimate: number;
}

export interface ScopeKey {
  scope: AiContextScope;
  userId: string;
  teamId: string | null;
  organizationId: string;
}

const CHARS_PER_TOKEN = 4;

/**
 * Lookup the context profile for a given scope. Returns null when no
 * row exists yet — the API layer lazily creates one on the first
 * write. Exported for reuse by `update.ts` / `upload.ts`.
 *
 * Uses the Drizzle v2 query-builder object shorthand (`where: { ... }`)
 * so the partial unique constraints on (teamId, orgId) / (userId, orgId)
 * map cleanly to the discriminated scope.
 */
export const findContextProfile = async (
  key: ScopeKey,
): Promise<AiContextProfile | null> => {
  if (key.scope === "team") {
    if (!key.teamId) return null;
    const row = await db.query.aiContextProfiles.findFirst({
      where: {
        scope: "team",
        teamId: key.teamId,
        organizationId: key.organizationId,
      },
    });
    return row ?? null;
  }
  const row = await db.query.aiContextProfiles.findFirst({
    where: {
      scope: "user",
      userId: key.userId,
      organizationId: key.organizationId,
    },
  });
  return row ?? null;
};

/**
 * The profile the caller's scope owns, or a 404 — the authorisation step every
 * file-level operation starts with.
 *
 * A context file belongs to a profile, and a profile belongs to one team or to
 * one person. The `organization_id` denormalised onto `ai_context_files` was
 * added to save a JOIN when LISTING; three services then used it as the
 * permission check, which let any member of the organisation reach any team's
 * file — and any colleague's personal one — given its id.
 *
 * The 404 deliberately says "file", not "profile": whether a file exists is
 * itself information the caller has no right to.
 */
export const requireOwnedProfileId = async (key: ScopeKey): Promise<string> => {
  const profile = await findContextProfile(key);
  if (!profile) return throwHttpError(404, notFound("Context file not found"));
  return profile.id;
};

const summariseProfile = (
  profile: AiContextProfile,
  updatedBy: { id: string; name: string } | null,
  mutedByMe: boolean,
): ContextProfileSummary => ({
  id: profile.id,
  scope: profile.scope,
  instructions: profile.instructions,
  mutedByMe,
  updatedById: profile.updatedById,
  updatedBy,
  updatedAt: profile.updatedAt,
});

const summariseFile = (
  file: AiContextFile,
  mutedByMe: boolean,
): ContextFileSummary => ({
  id: file.id,
  filename: file.filename,
  mimeType: file.mimeType,
  size: file.size,
  status: file.status,
  errorMessage: file.errorMessage,
  charCount: file.charCount,
  pageCount: file.pageCount,
  enabled: file.enabled,
  mutedByMe,
  uploadedById: file.uploadedById,
  createdAt: file.createdAt,
  updatedAt: file.updatedAt,
});

/**
 * Load a profile + its files for display in the settings UI.
 * Empty-state safe: if no profile exists yet we return a synthetic
 * response with an empty profile shell so the UI can render the
 * "upload first file to start" state.
 */
export const getContextProfile = async (
  key: ScopeKey,
): Promise<ContextProfileResponse> => {
  const profile = await findContextProfile(key);

  if (!profile) {
    return {
      profile: {
        id: "",
        scope: key.scope,
        instructions: "",
        mutedByMe: false,
        updatedById: null,
        updatedBy: null,
        updatedAt: new Date(0),
      },
      files: [],
      totalCharCount: 0,
      tokenEstimate: 0,
    };
  }

  // Load everything in parallel:
  //   - files belonging to the profile
  //   - updatedBy user (for team-scope UI attribution)
  //   - per-user mutes for this profile and all its files (team scope
  //     only; user scope can't mute itself so this resolves to empty).
  const [files, updatedByRow, profileMute, fileMutes] = await Promise.all([
    db
      .select()
      .from(aiContextFiles)
      .where(eq(aiContextFiles.profileId, profile.id)),
    profile.updatedById
      ? db.query.user.findFirst({
          where: { id: profile.updatedById },
          columns: { id: true, name: true },
        })
      : Promise.resolve(null),
    db.query.aiContextUserProfileMutes.findFirst({
      where: {
        userId: key.userId,
        profileId: profile.id,
      },
    }),
    db
      .select({ fileId: aiContextUserFileMutes.fileId })
      .from(aiContextUserFileMutes)
      .where(eq(aiContextUserFileMutes.userId, key.userId)),
  ]);

  const mutedFileIds = new Set(fileMutes.map((row) => row.fileId));

  const filesSummary = files
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.filename.localeCompare(b.filename),
    )
    .map((f) => summariseFile(f, mutedFileIds.has(f.id)));

  const totalCharCount = filesSummary
    .filter((f) => f.enabled && !f.mutedByMe && f.status === "ready")
    .reduce((acc, f) => acc + (f.charCount ?? 0), 0);

  return {
    profile: summariseProfile(
      profile,
      updatedByRow ?? null,
      Boolean(profileMute),
    ),
    files: filesSummary,
    totalCharCount,
    tokenEstimate: Math.ceil(totalCharCount / CHARS_PER_TOKEN),
  };
};

/**
 * Fetch the extracted markdown for a single file so the settings UI
 * can show a preview modal. Scopes strictly by `organizationId` to
 * prevent cross-tenant reads.
 */
export const getContextFileContent = async (args: {
  fileId: string;
  scope: ScopeKey;
}): Promise<{ file: AiContextFile; content: string | null }> => {
  const file = await db.query.aiContextFiles.findFirst({
    where: {
      id: args.fileId,
      profileId: await requireOwnedProfileId(args.scope),
    },
  });
  if (!file) {
    return throwHttpError(404, notFound("Context file not found"));
  }
  return { file, content: file.content };
};
