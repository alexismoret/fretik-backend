import { z } from "@hono/zod-openapi";
import {
  type AccessAuditAction,
  accessAuditActionSchema,
  accessLevelSchema,
  accessPrincipalTypeSchema,
  accessResourceTypeSchema,
} from "./access";

/**
 * The access journal as the organization's admins read it
 * (`GET /access/journal`): every change to who may do what, newest first.
 */

/** The kinds of change the journal is filtered by. */
export const JOURNAL_CATEGORIES = [
  "people",
  "teams",
  "sharing",
  "projects",
  "policies",
] as const;
export type JournalCategory = (typeof JOURNAL_CATEGORIES)[number];

/** Which actions each kind of change gathers; every action is in one. */
export const JOURNAL_ACTIONS: Readonly<
  Record<JournalCategory, readonly AccessAuditAction[]>
> = {
  people: [
    "member.role_changed",
    "member.removed",
    "invitation.sent",
    "invitation.canceled",
    "invitation.accepted",
    "invitation.rejected",
    "team_member.added",
    "team_member.removed",
    "team_role.changed",
  ],
  teams: ["team.created", "team.renamed", "team.deleted"],
  sharing: [
    "grant.created",
    "grant.updated",
    "grant.removed",
    "restriction.changed",
    "request.created",
    "request.decided",
  ],
  projects: [
    "project.created",
    "project.archived",
    "project.restored",
    "project.deleted",
    "project.content_moved",
  ],
  policies: ["organization_policy.updated", "team_policy.updated"],
};

export const JOURNAL_PAGE_SIZE = 50;

export const accessJournalQuerySchema = z.object({
  category: z.enum(JOURNAL_CATEGORIES).optional(),
  /** The changes a person made, or that were about them. */
  userId: z.uuid().optional(),
  /** Where the previous page stopped (`nextCursor`). */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(JOURNAL_PAGE_SIZE),
});
export type AccessJournalQuery = z.infer<typeof accessJournalQuerySchema>;

/**
 * What an entry says beyond who, what and whom, one field per fact whatever
 * the action: the ones an action does not carry are null.
 */
export const accessJournalDetailsSchema = z
  .object({
    /** The level given, asked for, or approved. */
    level: accessLevelSchema.nullable(),
    previousLevel: accessLevelSchema.nullable(),
    /** A resource restricted (true) or opened to where it lives (false). */
    restricted: z.boolean().nullable(),
    /** How a request was answered: approved, denied, canceled. */
    decision: z.string().nullable(),
    /** The address an invitation went to. */
    email: z.string().nullable(),
    /** An organization or team role. */
    role: z.string().nullable(),
    /** A role or a name before and after the change. */
    from: z.string().nullable(),
    to: z.string().nullable(),
    /** The team a change happened in, by its name then. */
    team: z.string().nullable(),
    /**
     * A move across projects: where it came from and went. Null for a team's
     * root; a project is named only when the reader can open it.
     */
    fromProject: z.object({ name: z.string().nullable() }).nullable(),
    toProject: z.object({ name: z.string().nullable() }).nullable(),
    /** A policy change, setting by setting. */
    changes: z
      .array(
        z.object({
          setting: z.string(),
          from: z.unknown(),
          to: z.unknown(),
        }),
      )
      .nullable(),
    /** Someone who left on their own rather than was taken out. */
    left: z.boolean(),
    /** When a guest's access ends. */
    expiresAt: z.date().nullable(),
    /** How many items an invitation was for. */
    items: z.number().nullable(),
    /** Why the system made the change (a team deleted). */
    reason: z.string().nullable(),
  })
  .openapi("AccessJournalDetails");
export type AccessJournalDetails = z.infer<typeof accessJournalDetailsSchema>;

export const accessJournalEntrySchema = z
  .object({
    id: z.uuid(),
    createdAt: z.date(),
    action: accessAuditActionSchema,
    /** Who made the change; null for the system's own, or someone deleted since. */
    actor: z.object({ userId: z.string(), name: z.string() }).nullable(),
    /**
     * The item it was about. Its name is null when the reader cannot open it
     * now: the journal says who may open a private item, never what it is.
     */
    resource: z
      .object({
        type: accessResourceTypeSchema,
        id: z.uuid(),
        name: z.string().nullable(),
      })
      .nullable(),
    /** Who or what the change was about: a person, a team, an invitation. */
    principal: z
      .object({
        type: accessPrincipalTypeSchema,
        id: z.string(),
        name: z.string().nullable(),
      })
      .nullable(),
    details: accessJournalDetailsSchema,
  })
  .openapi("AccessJournalEntry");
export type AccessJournalEntry = z.infer<typeof accessJournalEntrySchema>;

export const accessJournalPageSchema = z
  .object({
    entries: z.array(accessJournalEntrySchema),
    /** Pass as `cursor` for the next, older page; null on the last one. */
    nextCursor: z.string().nullable(),
  })
  .openapi("AccessJournalPage");
export type AccessJournalPage = z.infer<typeof accessJournalPageSchema>;
