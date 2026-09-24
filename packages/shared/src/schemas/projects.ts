import { z } from "@hono/zod-openapi";
import { accessLevelSchema } from "./access";

/**
 * Projects: a team's container for one subject (a client, a case, a topic),
 * with its own chats, files, pages and workflows, its own instructions for
 * the assistant, and its own members.
 *
 * A project belongs to ONE team, which pays for it and whose settings it
 * uses. Its members are its grants, managed from the share dialog like any
 * item's (`/access/resources/project/{id}`): people, teams, the whole
 * organization. Open (the default), everyone in its team reaches it through
 * their team role; restricted, only its members do.
 *
 * What a level on a project gives:
 *   view  read what is open to the project
 *   use   take part: one's own chats, files, pages and workflows in it
 *   edit  + its instructions, and editing what is open to it
 *   full  + its members, its settings, archiving and deleting it
 */

export const PROJECT_NAME_MAX = 120;
export const PROJECT_DESCRIPTION_MAX = 2000;
/** Read on every turn of a chat in the project: kept to a prompt's budget. */
export const PROJECT_INSTRUCTIONS_MAX = 20_000;

const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_NAME_MAX)
  .openapi({ example: "Client onboarding" });

/** A Lucide icon name, bare (`briefcase`), as the app's icon picker stores it. */
const projectIconSchema = z.string().trim().min(1).max(64);
/** A color name from the app's palette (`teal`), as the icon picker stores it. */
const projectColorSchema = z.string().trim().min(1).max(32);

export const projectSummarySchema = z
  .object({
    id: z.uuid(),
    teamId: z.uuid(),
    /** The team it belongs to, by name: a project may be another team's. */
    teamName: z.string(),
    name: z.string(),
    description: z.string(),
    icon: z.string().nullable(),
    color: z.string().nullable(),
    /** Restricted: only its members reach it, not its whole team. */
    restricted: z.boolean(),
    /** Archived projects are read-only and hidden from the lists by default. */
    archivedAt: z.date().nullable(),
    ownerUserId: z.uuid().nullable(),
    /** The caller's level on it. */
    level: accessLevelSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .openapi("ProjectSummary");
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const projectDetailSchema = projectSummarySchema
  .extend({
    /** Read by the assistant on every turn of a chat in the project. */
    instructions: z.string(),
    owner: z
      .object({
        userId: z.uuid(),
        name: z.string(),
        email: z.string(),
        image: z.string().nullable(),
      })
      .nullable(),
  })
  .openapi("ProjectDetail");
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const projectsListSchema = z
  .object({ projects: z.array(projectSummarySchema) })
  .openapi("Projects");

/** Someone who reaches a project, and at what level, whatever the path. */
export const projectPersonSchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    level: accessLevelSchema,
  })
  .openapi("ProjectPerson");
export type ProjectPerson = z.infer<typeof projectPersonSchema>;

export const projectPeopleSchema = z
  .object({ people: z.array(projectPersonSchema) })
  .openapi("ProjectPeople");

export const projectListQuerySchema = z.object({
  /** Only this team's projects. Every team's the caller reaches when omitted. */
  teamId: z.uuid().optional(),
  includeArchived: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});

export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).default(""),
    icon: projectIconSchema.nullish(),
    color: projectColorSchema.nullish(),
    /** Keep it to the people it is shared with rather than its whole team. */
    restricted: z.boolean().default(false),
  })
  .openapi("CreateProject");
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).optional(),
    icon: projectIconSchema.nullable().optional(),
    color: projectColorSchema.nullable().optional(),
    instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX).optional(),
  })
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    {
      message: "Nothing to change.",
    },
  )
  .openapi("UpdateProject");
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/** The kinds of items a project holds. */
export const PROJECT_CONTENT_TYPES = [
  "conversation",
  "folder",
  "document",
  "page",
  "workflow",
] as const;
export type ProjectContentType = (typeof PROJECT_CONTENT_TYPES)[number];
export const projectContentTypeSchema = z.enum(PROJECT_CONTENT_TYPES);

/**
 * Put an item in a project (`projectId`), or take it out to its team
 * (`null`). A file or folder goes to the root of its new place.
 */
export const moveToProjectSchema = z
  .object({
    type: projectContentTypeSchema,
    id: z.uuid(),
    projectId: z.uuid().nullable(),
  })
  .openapi("MoveToProject");
export type MoveToProjectInput = z.infer<typeof moveToProjectSchema>;
