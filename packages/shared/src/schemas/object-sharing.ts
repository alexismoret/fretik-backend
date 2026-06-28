import { z } from "zod";
import { OBJECT_PERMISSIONS } from "../db/schema";

/**
 * Wire schemas for the sharing layer — type grants and record shares. A
 * `granteeTeamId` of `null` means "the whole organization" (org-wide). The
 * owning team and organization are taken from the session, never the body.
 */

export const objectPermissionSchema = z.enum(OBJECT_PERMISSIONS);

/** Grant/share a type or record with a team (or org-wide when grantee is null). */
export const shareRequestSchema = z.object({
  granteeTeamId: z.uuid().nullable(),
  permission: objectPermissionSchema.default("read"),
});

/** Revoke/unshare the grant for a given grantee (null = the org-wide grant). */
export const unshareRequestSchema = z.object({
  granteeTeamId: z.uuid().nullable(),
});

/** One grantee on a type/record, with the team name (null = org-wide). */
export const granteeEntrySchema = z.object({
  id: z.uuid(),
  granteeTeamId: z.uuid().nullable(),
  granteeTeamName: z.string().nullable(),
  permission: objectPermissionSchema,
});

export const granteeListSchema = z.array(granteeEntrySchema);

export const revokeResultSchema = z.object({ revoked: z.number().int() });

/** Index-page sharing state for the active team. */
export const sharedTypeIdsSchema = z.object({
  sharedOut: z.array(z.uuid()),
  sharedWithMe: z.array(z.uuid()),
});

export const sharedRecordIdsSchema = z.array(z.uuid());

export type ShareRequest = z.infer<typeof shareRequestSchema>;
export type UnshareRequest = z.infer<typeof unshareRequestSchema>;
export type GranteeEntryResponse = z.infer<typeof granteeEntrySchema>;
