import { z } from "zod";
import { OBJECT_PERMISSIONS } from "../db/schema";

/**
 * Wire schemas for the sharing layer — type grants and record shares. A
 * `granteeTeamId` of `null` means "the whole organization" (org-wide). The
 * owning team and organization are taken from the session, never the body.
 */

export const objectPermissionSchema = z.enum(OBJECT_PERMISSIONS);

/**
 * Audience — the cross-team sharing target set, the SAME descriptor used at
 * create/update time by the UI, the API, the AI tools, and the Python SDK.
 *   - `internal` → the owning team only (no grants).
 *   - `org`      → every team in the organization (one org-wide grant).
 *   - `teams`    → an explicit list of teams, each with its own permission.
 * The owning team and organization come from the session/JWT, never the body.
 */
export const audienceTeamSchema = z.object({
  teamId: z.uuid(),
  permission: objectPermissionSchema.default("read"),
});

export const audienceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("internal") }),
  z.object({
    mode: z.literal("org"),
    permission: objectPermissionSchema.default("read"),
  }),
  // An empty `teams` list is allowed and means "no teams yet" (≡ internal) — the
  // picker can sit in teams-mode before any team is added.
  z.object({
    mode: z.literal("teams"),
    teams: z.array(audienceTeamSchema),
  }),
]);

/**
 * Record sharing descriptor. `inherit:true` (default) follows the type's audience
 * live; `inherit:false` gives the record its OWN audience (always validated as a
 * subset of the type's). Reset-to-inherit is just `{ inherit: true }`.
 */
export const recordSharingSchema = z.discriminatedUnion("inherit", [
  z.object({ inherit: z.literal(true) }),
  z.object({ inherit: z.literal(false), audience: audienceSchema }),
]);

export type Audience = z.infer<typeof audienceSchema>;
export type RecordSharing = z.infer<typeof recordSharingSchema>;

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
