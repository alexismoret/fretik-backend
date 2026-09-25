import { z } from "@hono/zod-openapi";

/**
 * Access policies — what an administrator can open or close beyond the roles.
 *
 * Acting takes TWO keys: the role (organization or team) and, for the
 * capabilities listed here, the organization's policy. A policy never widens
 * a role past what it is (a viewer cannot be allowed to delete); it only says
 * how far down the roles a capability reaches.
 *
 * Every DEFAULT reproduces what the product allowed before policies existed,
 * so turning the engine on changes nothing until an administrator decides
 * otherwise. Stored sparse (`organization_settings.access_policy`,
 * `team_settings.access_policy`): `{}` means "never configured".
 *
 * Turning a policy off keeps what already exists — a published page stays
 * published, an existing share stays — and stops what comes next; the
 * interface says "Turned off by your administrator".
 */

/** Who, among an organization's people, a capability reaches. */
export const POLICY_AUDIENCES = ["admins", "leads", "members"] as const;
export type PolicyAudience = (typeof POLICY_AUDIENCES)[number];

export const organizationAccessPolicySchema = z
  .object({
    /** Creating teams. Before policies: organization admins only. */
    teamCreation: z.enum(["admins", "members"]),
    /** Creating projects in a team. Members could create anything before. */
    projectCreation: z.enum(POLICY_AUDIENCES),
    /** Inviting people INTO the organization (members). */
    memberInvitations: z.enum(["admins", "leads"]),
    /** Inviting guests from outside, on the items they will see. */
    guestInvitations: z.enum(POLICY_AUDIENCES),
    /** How long a guest's access lasts, in days; null = until removed. */
    guestAccessDays: z.number().int().min(1).max(365).nullable(),
    /** Sharing with people or teams outside one's own team. */
    crossTeamSharing: z.boolean(),
    /** Sharing with the whole organization at once. */
    organizationSharing: z.boolean(),
    /** Public links: published pages and public forms. */
    publicLinks: z.enum(["nobody", "leads", "members"]),
    /** Creating, changing and removing a team's connected apps. */
    teamConnections: z.enum(["leads", "members"]),
    /** Editing a team's instructions, files and memory for the assistant. */
    teamContext: z.enum(["leads", "members"]),
    /** Letting a workflow act without approvals (`autonomous`). */
    autonomousWorkflows: z.enum(["leads", "members"]),
  })
  .openapi("OrganizationAccessPolicy");
export type OrganizationAccessPolicy = z.infer<
  typeof organizationAccessPolicySchema
>;

export const organizationAccessPolicyPatchSchema =
  organizationAccessPolicySchema
    .partial()
    .strict()
    .openapi("OrganizationAccessPolicyPatch");
export type OrganizationAccessPolicyPatch = z.infer<
  typeof organizationAccessPolicyPatchSchema
>;

export const DEFAULT_ORGANIZATION_ACCESS_POLICY: OrganizationAccessPolicy = {
  teamCreation: "admins",
  projectCreation: "members",
  memberInvitations: "admins",
  guestInvitations: "admins",
  guestAccessDays: null,
  crossTeamSharing: true,
  organizationSharing: true,
  publicLinks: "members",
  teamConnections: "members",
  teamContext: "members",
  autonomousWorkflows: "members",
};

export const teamAccessPolicySchema = z
  .object({
    /**
     * What a team MEMBER (not a lead, not a viewer) gets on the team's
     * content. `full` is what everyone had before roles: rename, move,
     * delete, share. `edit` keeps deleting and sharing with the leads and
     * each item's owner.
     */
    memberContentLevel: z.enum(["edit", "full"]),
  })
  .openapi("TeamAccessPolicy");
export type TeamAccessPolicy = z.infer<typeof teamAccessPolicySchema>;

export const teamAccessPolicyPatchSchema = teamAccessPolicySchema
  .partial()
  .strict()
  .openapi("TeamAccessPolicyPatch");
export type TeamAccessPolicyPatch = z.infer<typeof teamAccessPolicyPatchSchema>;

export const DEFAULT_TEAM_ACCESS_POLICY: TeamAccessPolicy = {
  memberContentLevel: "full",
};

/** A stored value's own entries; none when it is not an object at all. */
const entriesOf = (stored: unknown): [string, unknown][] =>
  typeof stored === "object" && stored !== null ? Object.entries(stored) : [];

/**
 * Merge a stored value over the defaults, key by key. A key from an older
 * shape, or one an operator wrote by hand, falls back to its default instead
 * of failing the whole policy: this sits on every access decision.
 */
const resolveSparse = <T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  defaults: T,
  stored: unknown,
): T => {
  let resolved = defaults;
  for (const [key, value] of entriesOf(stored)) {
    if (!(key in defaults)) continue;
    const parsed = schema.safeParse({ ...resolved, [key]: value });
    if (parsed.success) resolved = parsed.data;
  }
  return resolved;
};

/**
 * The keys an administrator actually set, and set to a valid value — what the
 * row stores. A key that no longer exists or no longer parses is dropped, so
 * it falls back to its default like `resolveSparse` reads it.
 */
const overridesOf = <T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  defaults: T,
  stored: unknown,
): Partial<T> => {
  const resolved = resolveSparse(schema, defaults, stored);
  const overrides: Partial<T> = {};
  for (const [key, value] of entriesOf(stored)) {
    if (!(key in defaults)) continue;
    if (JSON.stringify(resolved[key]) !== JSON.stringify(value)) continue;
    Object.assign(overrides, { [key]: value });
  }
  return overrides;
};

export const organizationAccessPolicyOverrides = (
  stored: unknown,
): OrganizationAccessPolicyPatch =>
  overridesOf(
    organizationAccessPolicySchema,
    DEFAULT_ORGANIZATION_ACCESS_POLICY,
    stored,
  );

export const teamAccessPolicyOverrides = (
  stored: unknown,
): TeamAccessPolicyPatch =>
  overridesOf(teamAccessPolicySchema, DEFAULT_TEAM_ACCESS_POLICY, stored);

export const resolveOrganizationAccessPolicy = (
  stored: unknown,
): OrganizationAccessPolicy =>
  resolveSparse(
    organizationAccessPolicySchema,
    DEFAULT_ORGANIZATION_ACCESS_POLICY,
    stored,
  );

export const resolveTeamAccessPolicy = (stored: unknown): TeamAccessPolicy =>
  resolveSparse(teamAccessPolicySchema, DEFAULT_TEAM_ACCESS_POLICY, stored);
