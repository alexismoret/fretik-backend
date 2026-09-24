import { z } from "@hono/zod-openapi";

/**
 * Access control — the vocabulary shared by the database, the engine
 * (`authz/`) and the API.
 *
 * The SINGLE source of truth for every access enum value, kept db-free like
 * `schemas/workflows.ts`: `db/schema/access.ts` builds its `pgEnum`s FROM the
 * tuples below, so the database, the engine and the Zod boundaries cannot
 * drift. Import nothing from `../db` here.
 */

/**
 * The four levels, weakest first. The ORDER is the contract: the engine
 * compares levels by index, and Postgres compares the `access_level` enum by
 * declaration order — both read this tuple.
 */
export const ACCESS_LEVELS = ["view", "use", "edit", "full"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];
export const accessLevelSchema = z.enum(ACCESS_LEVELS);

export const ACCESS_RESOURCE_TYPES = [
  "folder",
  "document",
  "page",
  "workflow",
  "conversation",
  "collection",
  "connection",
  "project",
] as const;
export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number];
export const accessResourceTypeSchema = z.enum(ACCESS_RESOURCE_TYPES);

export const ACCESS_PRINCIPAL_TYPES = [
  "user",
  "team",
  "project",
  "organization",
  "invitation",
] as const;
export type AccessPrincipalType = (typeof ACCESS_PRINCIPAL_TYPES)[number];
export const accessPrincipalTypeSchema = z.enum(ACCESS_PRINCIPAL_TYPES);

/** The principals a person can pick in the share dialog. */
export const SHAREABLE_PRINCIPAL_TYPES = [
  "user",
  "team",
  "project",
  "organization",
] as const satisfies readonly AccessPrincipalType[];
export type ShareablePrincipalType = (typeof SHAREABLE_PRINCIPAL_TYPES)[number];
export const shareablePrincipalTypeSchema = z.enum(SHAREABLE_PRINCIPAL_TYPES);

export const TEAM_ROLES = ["lead", "member", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const teamRoleSchema = z.enum(TEAM_ROLES);

/**
 * Organization roles, as Better Auth stores them in `member.role`. `bot` is
 * the team agent's service account: a member for the engine, hidden from the
 * directory. `guest` is someone from outside who only sees what is shared
 * with them.
 */
export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "member",
  "guest",
  "bot",
] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export const organizationRoleSchema = z.enum(ORGANIZATION_ROLES);

/**
 * The roles a person can be given from the members page, or invited with.
 * `owner` moves only by a transfer of ownership; `guest` is not a role one is
 * moved into, it is how someone from outside arrives, on the items shared
 * with them.
 */
export const ASSIGNABLE_ORGANIZATION_ROLES = [
  "admin",
  "member",
] as const satisfies readonly OrganizationRole[];
export type AssignableOrganizationRole =
  (typeof ASSIGNABLE_ORGANIZATION_ROLES)[number];
export const assignableOrganizationRoleSchema = z.enum(
  ASSIGNABLE_ORGANIZATION_ROLES,
);

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "denied",
  "canceled",
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];
export const accessRequestStatusSchema = z.enum(ACCESS_REQUEST_STATUSES);

/**
 * Every capability, by name — what a person may do that is not about ONE
 * resource. The catalog that DECIDES each one is `authz/capabilities.ts`,
 * which must implement exactly these (it is typed against this tuple), and
 * the client receives decisions keyed by them (`GET /access/me`).
 */
export const CAPABILITY_KEYS = [
  "organization.manage",
  "members.manage",
  "policies.manage",
  "audit.read",
  "requests.review",
  "organization.templates",
  "directory.read",
  "teams.create",
  "share.organization",
  "share.cross_team",
  "team.manage",
  "team.members.manage",
  "team.settings.manage",
  "team.memory.manage",
  "members.invite",
  "guests.invite",
  "team.content.create",
  "projects.create",
  "team.context.edit",
  "team.connections.manage",
  "team.workflows.autonomous",
  "share.public_link",
] as const;
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
export const capabilityKeySchema = z.enum(CAPABILITY_KEYS);

/** The role a refused capability needs, for the refusal's wording. */
export const REQUIRED_ROLES = ["owner", "admin", "lead", "member"] as const;
export type RequiredRole = (typeof REQUIRED_ROLES)[number];

/**
 * A capability decided for one person: allowed, or refused with the reason
 * and the least role that would be allowed (when one would).
 */
export const capabilityDecisionSchema = z
  .discriminatedUnion("allowed", [
    z.object({ allowed: z.literal(true) }),
    z.object({
      allowed: z.literal(false),
      reason: z.enum(["ROLE_REQUIRED", "POLICY_DISABLED", "GUEST_RESTRICTED"]),
      requiredRole: z.enum(REQUIRED_ROLES).nullable(),
    }),
  ])
  .openapi("CapabilityDecision");
export type CapabilityDecision = z.infer<typeof capabilityDecisionSchema>;

/**
 * What the access journal records (`access_audit_log.action`): each change to
 * who may do what. The journal is for administrators; it never holds content.
 */
export const ACCESS_AUDIT_ACTIONS = [
  "member.role_changed",
  "member.removed",
  "invitation.sent",
  "invitation.canceled",
  "team.created",
  "team.renamed",
  "team.deleted",
  "team_member.added",
  "team_member.removed",
  "team_role.changed",
  "organization_policy.updated",
  "team_policy.updated",
  "grant.created",
  "grant.updated",
  "grant.removed",
  "restriction.changed",
  "owner.transferred",
  "request.created",
  "request.decided",
] as const;
export type AccessAuditAction = (typeof ACCESS_AUDIT_ACTIONS)[number];
export const accessAuditActionSchema = z.enum(ACCESS_AUDIT_ACTIONS);

/**
 * Why an action was refused. The client translates each one into a sentence
 * and decides whether to offer "Request access".
 *
 *   INSUFFICIENT_LEVEL  the resource is visible, the level is not enough
 *   ROLE_REQUIRED       the capability needs a role the person does not have
 *   POLICY_DISABLED     an administrator turned the capability off
 *   GUEST_RESTRICTED    guests never do this
 *   LEVEL_CAP           the resource cannot be shared above a level
 *   CANNOT_EXCEED_OWN   nobody gives more than they have
 */
export const ACCESS_DENIAL_REASONS = [
  "INSUFFICIENT_LEVEL",
  "ROLE_REQUIRED",
  "POLICY_DISABLED",
  "GUEST_RESTRICTED",
  "LEVEL_CAP",
  "CANNOT_EXCEED_OWN",
] as const;
export type AccessDenialReason = (typeof ACCESS_DENIAL_REASONS)[number];
export const accessDenialReasonSchema = z.enum(ACCESS_DENIAL_REASONS);

/** Someone to ask, and why they can answer. */
export const accessContactSchema = z.object({
  userId: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  reason: z.enum(["owner", "full_access", "team_lead", "admin"]),
});
export type AccessContact = z.infer<typeof accessContactSchema>;

/**
 * The `access` part of a 403 body: everything the client needs to explain the
 * refusal and, when it makes sense, offer to ask for access.
 */
export const accessDenialSchema = z
  .object({
    reason: accessDenialReasonSchema,
    /** The level the action needs, for a resource refusal. */
    required: accessLevelSchema.nullable(),
    /** The level the person has on it, for a resource refusal. */
    current: accessLevelSchema.nullable(),
    /** The capability refused, for a capability refusal. */
    capability: z.string().nullable(),
    /**
     * The least role that would be allowed, for a capability refusal —
     * null when no role would be (a policy turned it off for everyone).
     */
    requiredRole: z.enum(REQUIRED_ROLES).nullable(),
    resource: z
      .object({ type: accessResourceTypeSchema, id: z.string() })
      .nullable(),
    /** Who can grant it — resource owners, team leads or admins. */
    ask: z.array(accessContactSchema),
    /** Whether "Request access" can be offered at all. */
    requestable: z.boolean(),
  })
  .openapi("AccessDenial");
export type AccessDenial = z.infer<typeof accessDenialSchema>;

/**
 * What a resource DTO carries about the viewer, so the client never guesses
 * which actions to show: it compares `level` with what an action needs.
 */
export const resourceAccessSchema = z
  .object({
    /** The viewer's effective level. Never null on a resource they can see. */
    level: accessLevelSchema,
    isOwner: z.boolean(),
    /** Restricted: only its owner and its grants reach it. */
    restricted: z.boolean(),
  })
  .openapi("ResourceAccess");
export type ResourceAccess = z.infer<typeof resourceAccessSchema>;
