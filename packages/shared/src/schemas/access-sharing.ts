import { z } from "@hono/zod-openapi";
import {
  accessLevelSchema,
  capabilityDecisionSchema,
  shareablePrincipalTypeSchema,
} from "./access";

/**
 * Sharing one resource: who has access to it and at what level, whether it
 * inherits from its folder or container, and the changes the share dialog
 * makes. The shapes of `/access/resources/{type}/{id}`.
 *
 * The types listed here are the ones whose sharing goes through the engine's
 * own grants (`access_grants`). Conversations keep their seats, collections
 * the grants the SQL tool enforces; they join with their own stores.
 */
export const SHARING_RESOURCE_TYPES = [
  "folder",
  "document",
  "page",
  "workflow",
] as const;
export type SharingResourceType = (typeof SHARING_RESOURCE_TYPES)[number];
export const sharingResourceTypeSchema = z.enum(SHARING_RESOURCE_TYPES);

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

const personSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});

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
    owner: personSchema.nullable(),
    /** The explicit grants, strongest first. */
    holders: z.array(accessHolderSchema),
    general: z.object({
      /** Restricted: only the owner and the holders reach it. */
      restricted: z.boolean(),
      /** What it inherits from while it is not restricted. */
      inheritsFrom: inheritanceSourceSchema.nullable(),
      /**
       * Only the owner may restrict it: a restricted workflow runs with its
       * owner's access, and nobody else may make it act as them.
       */
      ownerRestrictsOnly: z.boolean(),
    }),
    /** The levels this type can be shared at, weakest first. */
    offeredLevels: z.array(accessLevelSchema),
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
