import { z } from "@hono/zod-openapi";
import {
  capabilityDecisionSchema,
  capabilityKeySchema,
  organizationRoleSchema,
  teamRoleSchema,
} from "./access";
import {
  organizationAccessPolicyPatchSchema,
  organizationAccessPolicySchema,
} from "./access-policy";

/**
 * The shapes of the `/access` API: who the caller is to the engine, what the
 * organization's policy says, and the roles grid the settings draw.
 */

/**
 * The caller's standing, and every capability decided for them in their
 * active team — what the app reads to show, hide or lock an action, so it
 * never re-derives a rule.
 */
export const accessMeSchema = z
  .object({
    userId: z.string(),
    organizationId: z.string(),
    orgRole: organizationRoleSchema,
    isOrgAdmin: z.boolean(),
    isGuest: z.boolean(),
    teams: z.array(z.object({ teamId: z.string(), role: teamRoleSchema })),
    activeTeamId: z.string().nullable(),
    capabilities: z.record(capabilityKeySchema, capabilityDecisionSchema),
  })
  .openapi("AccessMe");
export type AccessMe = z.infer<typeof accessMeSchema>;

export const organizationPolicyResponseSchema = z
  .object({
    policy: organizationAccessPolicySchema,
    /** What each setting is when nobody has chosen, for "Reset". */
    defaults: organizationAccessPolicySchema,
  })
  .openapi("OrganizationPolicyResponse");

export const updateOrganizationPolicySchema =
  organizationAccessPolicyPatchSchema;

/**
 * The standings a person can have, from the most to the least trusted. For a
 * team capability, lead / member / viewer are roles in THE team; for an
 * organization one, they are all ordinary members of the organization.
 */
export const ACCESS_STANDINGS = [
  "admin",
  "lead",
  "member",
  "viewer",
  "guest",
] as const;
export type AccessStanding = (typeof ACCESS_STANDINGS)[number];

export const roleMatrixRowSchema = z
  .object({
    capability: capabilityKeySchema,
    scope: z.enum(["organization", "team"]),
    /** The policy setting that moves this row, when one does. */
    policy: organizationAccessPolicySchema.keyof().nullable(),
    standings: z.record(z.enum(ACCESS_STANDINGS), capabilityDecisionSchema),
  })
  .openapi("RoleMatrixRow");
export type RoleMatrixRow = z.infer<typeof roleMatrixRowSchema>;

export const roleMatrixSchema = z
  .object({ rows: z.array(roleMatrixRowSchema) })
  .openapi("RoleMatrix");
