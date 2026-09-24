import { z } from "@hono/zod-openapi";
import {
  accessLevelSchema,
  accessRequestStatusSchema,
  capabilityDecisionSchema,
  shareablePrincipalTypeSchema,
} from "./access";

/**
 * Sharing one resource: who has access to it and at what level, whether it
 * inherits from its folder or container, and the changes the share dialog
 * makes. The shapes of `/access/resources/{type}/{id}`.
 *
 * Every type listed here is shared from the same dialog, through the same
 * routes. Most keep their grants in the engine's own table (`access_grants`);
 * a chat keeps its participants in its seats, and a collection its grants
 * where the SQL tool enforces them (`services/access/sharing/grant-store.ts`).
 */
export const SHARING_RESOURCE_TYPES = [
  "folder",
  "document",
  "page",
  "workflow",
  "conversation",
  "collection",
  "project",
] as const;
export type SharingResourceType = (typeof SHARING_RESOURCE_TYPES)[number];
export const sharingResourceTypeSchema = z.enum(SHARING_RESOURCE_TYPES);

export const isSharingResourceType = (
  type: string,
): type is SharingResourceType =>
  (SHARING_RESOURCE_TYPES as readonly string[]).includes(type);

/**
 * The types a person can be given by name, and so can ask for: every one but
 * a collection, which is its team's and shared with other teams.
 */
export const isRequestableResourceType = (
  type: string,
): type is Exclude<SharingResourceType, "collection"> =>
  isSharingResourceType(type) && type !== "collection";

export const resourceAccessParamsSchema = z.object({
  type: sharingResourceTypeSchema.openapi({
    param: { name: "type", in: "path" },
  }),
  id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
});

export const resourceGrantParamsSchema = resourceAccessParamsSchema.extend({
  principalType: shareablePrincipalTypeSchema.openapi({
    param: { name: "principalType", in: "path" },
  }),
  principalId: z.uuid().openapi({ param: { name: "principalId", in: "path" } }),
});

export const accessPersonSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});
export type AccessPerson = z.infer<typeof accessPersonSchema>;

/**
 * Someone asking for more access to a resource they can see
 * (`/access/resources/{type}/{id}/requests`, `schemas/access-requests.ts`).
 */
export const accessRequestSchema = z
  .object({
    id: z.string(),
    resource: z.object({
      type: sharingResourceTypeSchema,
      id: z.string(),
      name: z.string(),
    }),
    requester: accessPersonSchema,
    /** The level asked for. */
    level: accessLevelSchema,
    /** The requester's level when the request was read, null if none. */
    currentLevel: accessLevelSchema.nullable(),
    message: z.string().nullable(),
    status: accessRequestStatusSchema,
    createdAt: z.date(),
    decidedAt: z.date().nullable(),
    decidedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  })
  .openapi("AccessRequest");
export type AccessRequestView = z.infer<typeof accessRequestSchema>;

/**
 * Someone, or a group, holding an explicit grant. `email` and `image` are a
 * person's; `memberCount` is a group's (a team, a project, the whole
 * organization), its people only.
 */
export const accessHolderSchema = z
  .object({
    principalType: shareablePrincipalTypeSchema,
    principalId: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    image: z.string().nullable(),
    memberCount: z.number().int().nonnegative().nullable(),
    level: accessLevelSchema,
    grantedAt: z.date(),
    grantedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
  })
  .openapi("AccessHolder");
export type AccessHolder = z.infer<typeof accessHolderSchema>;

/** Where an open resource takes its access from. */
export const inheritanceSourceSchema = z
  .object({
    type: z.enum(["folder", "project", "team"]),
    id: z.string(),
    name: z.string(),
  })
  .openapi("InheritanceSource");
export type InheritanceSource = z.infer<typeof inheritanceSourceSchema>;

/**
 * The share dialog's model. Everyone who can see the resource reads it;
 * only who has full access (`canManage`) changes it.
 */
export const resourceAccessSchema = z
  .object({
    resource: z.object({
      type: sharingResourceTypeSchema,
      id: z.string(),
      name: z.string(),
      /** The team that holds it: sharing beyond it follows the policy. */
      teamId: z.string().nullable(),
    }),
    /** The caller's own level on it. */
    level: accessLevelSchema,
    /** Whether the caller may change who has access: full access, not a guest. */
    canManage: z.boolean(),
    /** Its owner, who always has full access. Null when their account is gone. */
    owner: accessPersonSchema.nullable(),
    /** The explicit grants, strongest first. */
    holders: z.array(accessHolderSchema),
    /** Pending requests for more access, for whoever may answer them. */
    requests: z.array(accessRequestSchema),
    general: z.object({
      /** Restricted: only the owner and the holders reach it. */
      restricted: z.boolean(),
      /** What it inherits from while it is not restricted. */
      inheritsFrom: inheritanceSourceSchema.nullable(),
      /**
       * Whether it can be restricted at all: a collection is always its
       * team's, and shared from there with other teams.
       */
      restrictable: z.boolean(),
      /**
       * Only the owner may restrict it: a restricted workflow runs with its
       * owner's access, and nobody else may make it act as them.
       */
      ownerRestrictsOnly: z.boolean(),
      /**
       * The most what it inherits from gives, when less than full: a chat
       * opened to its team is read there (`view`), taking part is a seat.
       */
      inheritedLevel: accessLevelSchema.nullable(),
    }),
    /** The levels this type can be shared at, weakest first. */
    offeredLevels: z.array(accessLevelSchema),
    /** The levels a team, a project or the organization can be given. */
    groupLevels: z.array(accessLevelSchema),
    /**
     * The most a person can hold on it, whatever is shared with them: one who
     * works where it lives (`team`), and anyone else. Below full on a
     * restricted workflow, which runs as its owner (`view` for all), and on a
     * chat, which only the people who work where it lives take part in
     * (`view` for anyone else).
     */
    ceilings: z.object({
      /** Someone of its team, or of its project when it is in one. */
      team: accessLevelSchema,
      outsider: accessLevelSchema,
      /**
       * Who `team` applies to, when that is not simply the people of its
       * team: for a chat in a project, the people who take part in the
       * project, whatever their team. Null otherwise.
       */
      insiders: z.array(z.string()).nullable(),
    }),
    /** Who this type can be shared with. */
    shareablePrincipals: z.array(shareablePrincipalTypeSchema),
    /**
     * The organization's sharing policy, decided for the caller: sharing
     * beyond the resource's team, and with the whole organization.
     */
    policy: z.object({
      crossTeam: capabilityDecisionSchema,
      organization: capabilityDecisionSchema,
    }),
  })
  .openapi("ResourceAccess");
export type ResourceAccess = z.infer<typeof resourceAccessSchema>;

/** At most one screen of picks at a time, like adding people to a team. */
export const MAX_PRINCIPALS_PER_SHARE = 50;

export const shareResourceSchema = z
  .object({
    principals: z
      .array(z.object({ type: shareablePrincipalTypeSchema, id: z.uuid() }))
      .min(1)
      .max(MAX_PRINCIPALS_PER_SHARE),
    level: accessLevelSchema,
  })
  .openapi("ShareResource");
export type ShareResourceInput = z.infer<typeof shareResourceSchema>;

export const setGrantLevelSchema = z
  .object({ level: accessLevelSchema })
  .openapi("SetGrantLevel");

export const setGeneralAccessSchema = z
  .object({ restricted: z.boolean() })
  .openapi("SetGeneralAccess");
