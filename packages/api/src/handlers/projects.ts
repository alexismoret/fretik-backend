import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { ConversationResponseSchema } from "@fretik/shared/schemas/ai";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseConflictSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  createProjectSchema,
  moveToProjectSchema,
  projectDetailSchema,
  projectListQuerySchema,
  projectPeopleSchema,
  projectsListSchema,
  updateProjectSchema,
} from "@fretik/shared/schemas/projects";
import { listProjectConversations } from "@fretik/shared/services/ai/list-in-project";
import { setProjectArchived } from "@fretik/shared/services/projects/archive";
import { createProject } from "@fretik/shared/services/projects/create";
import { deleteProject } from "@fretik/shared/services/projects/delete";
import { moveToProject } from "@fretik/shared/services/projects/move-content";
import { listProjectPeople } from "@fretik/shared/services/projects/people";
import {
  listProjects,
  readProjectDetail,
} from "@fretik/shared/services/projects/read";
import { updateProject } from "@fretik/shared/services/projects/update";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";

/**
 * `/projects` — a team's containers for one subject each: their chats, files,
 * pages and workflows, their instructions for the assistant, their people.
 *
 * Who is in a project is its grants, changed from the share dialog like any
 * item's (`/access/resources/project/{id}`). What a level on it gives:
 * `view` reads what is open to it, `use` takes part (one's own chats and
 * files), `edit` adds its instructions, `full` its members, its settings,
 * archiving and deleting it. A project is reached from any team: the rules
 * are decided on the project, never on the team the caller has open. Only
 * creating one happens in the active team.
 */
const projectRoutes = new OpenAPIHono<HonoLoggedAppType>();
projectRoutes.use("*", authMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "The projects the caller reaches, from their principal: one team's, or every team's.",
  ),
  summary: "List the projects the caller reaches",
  tags: ["Projects"],
  request: { query: projectListQuerySchema },
  responses: {
    200: {
      content: { "application/json": { schema: projectsListSchema } },
      description: "The projects, by name, with the caller's level on each",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const createProjectRoute = createRoute({
  method: "post",
  path: "/",
  middleware: access.capability("projects.create"),
  summary: "Create a project in the active team, owned by its creator",
  tags: ["Projects"],
  request: {
    body: {
      content: { "application/json": { schema: createProjectSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: projectDetailSchema } },
      description: "The new project",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const moveRoute = createRoute({
  method: "post",
  path: "/move",
  middleware: access.handler(
    "Full access on the item moved, and taking part in the project it lands in (`services/projects/move-content.ts`).",
  ),
  summary: "Put an item in a project, or take it out to its team",
  description:
    "A chat, a file, a folder, a page or a workflow. A file or a folder lands at the root of its new place, a folder with everything in it. `projectId: null` takes it back to its team.",
  tags: ["Projects"],
  request: {
    body: {
      content: { "application/json": { schema: moveToProjectSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ projectId: z.uuid().nullable() }),
        },
      },
      description: "Where the item is now",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/{id}",
  middleware: access.resource("project", "view"),
  summary: "One project, with its instructions and the caller's level",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: projectDetailSchema } },
      description: "The project",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/{id}",
  // Its instructions take edit; its settings take full (the service asks).
  middleware: access.resource("project", "edit"),
  summary: "Change a project's instructions, or its settings",
  description:
    "Instructions take edit access. Name, description, icon and color are its settings, and take full access. An archived project changes nothing until restored (409 `PROJECT_ARCHIVED`).",
  tags: ["Projects"],
  request: {
    params: paramsIdSchema,
    body: {
      content: { "application/json": { schema: updateProjectSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: projectDetailSchema } },
      description: "The project as changed",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseConflictSchema,
    ...responseInternalErrorSchema,
  },
});

const archiveRoute = createRoute({
  method: "post",
  path: "/{id}/archive",
  middleware: access.resource("project", "full"),
  summary: "Archive a project",
  description:
    "Everything in it stays, and reads as before; it takes nothing new and leaves the lists until restored.",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: projectDetailSchema } },
      description: "The archived project",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/{id}/restore",
  middleware: access.resource("project", "full"),
  summary: "Restore an archived project",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: projectDetailSchema } },
      description: "The restored project",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  middleware: access.resource("project", "full"),
  summary: "Delete a project; what it holds goes back to its team",
  description:
    "Nothing it holds is deleted and nobody gains access: chats stay with their participants, and from a restricted project everything that was open to it is restricted to its owner and the people it is shared with.",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            released: z.object({
              conversations: z.number().int(),
              folders: z.number().int(),
              documents: z.number().int(),
              pages: z.number().int(),
              workflows: z.number().int(),
            }),
          }),
        },
      },
      description: "What went back to the team",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const peopleRoute = createRoute({
  method: "get",
  path: "/{id}/people",
  middleware: access.resource("project", "view"),
  summary: "Everyone who reaches a project, with their level",
  description:
    "Whatever the path: a grant to them, to one of their teams or to the organization, its team while it is open, owning it. Those at `use` and above take part, and can be brought into its chats.",
  tags: ["Projects"],
  request: { params: paramsIdSchema },
  responses: {
    200: {
      content: { "application/json": { schema: projectPeopleSchema } },
      description: "The people, strongest level first",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

const conversationsRoute = createRoute({
  method: "get",
  path: "/{id}/conversations",
  middleware: access.resource("project", "view"),
  summary: "The project's chats the caller can read",
  description:
    "The ones they take part in, the ones opened to the project, and the ones shared with them, most recently active first, each with the caller's level.",
  tags: ["Projects"],
  request: {
    params: paramsIdSchema,
    query: z.object({
      search: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(ConversationResponseSchema) }),
        },
      },
      description: "The chats",
    },
    ...responseForbiddenSchema,
    ...responseNotFoundSchema,
    ...responseInternalErrorSchema,
  },
});

projectRoutes.openapi(listRoute, async (c) => {
  const { teamId, includeArchived } = c.req.valid("query");
  const projects = await listProjects({
    principal: c.get("principal"),
    ...(teamId === undefined ? {} : { teamId }),
    includeArchived,
  });
  return c.json({ projects }, 200);
});

projectRoutes.openapi(createProjectRoute, async (c) => {
  const created = await createProject({
    principal: c.get("principal"),
    teamId: c.get("team")?.id,
    project: c.req.valid("json"),
  });
  return c.json(created, 201);
});

projectRoutes.openapi(moveRoute, async (c) => {
  const { type, id, projectId } = c.req.valid("json");
  const moved = await moveToProject({
    principal: c.get("principal"),
    type,
    id,
    projectId,
  });
  return c.json(moved, 200);
});

projectRoutes.openapi(getRoute, async (c) => {
  const { node, level } = c.get("resource");
  return c.json(await readProjectDetail(node.id, level), 200);
});

projectRoutes.openapi(updateRoute, async (c) => {
  const { id } = c.req.valid("param");
  const updated = await updateProject({
    principal: c.get("principal"),
    projectId: id,
    patch: c.req.valid("json"),
  });
  return c.json(updated, 200);
});

projectRoutes.openapi(archiveRoute, async (c) => {
  const { id } = c.req.valid("param");
  const archived = await setProjectArchived({
    principal: c.get("principal"),
    projectId: id,
    archived: true,
  });
  return c.json(archived, 200);
});

projectRoutes.openapi(restoreRoute, async (c) => {
  const { id } = c.req.valid("param");
  const restored = await setProjectArchived({
    principal: c.get("principal"),
    projectId: id,
    archived: false,
  });
  return c.json(restored, 200);
});

projectRoutes.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  const released = await deleteProject({
    principal: c.get("principal"),
    projectId: id,
  });
  return c.json({ released }, 200);
});

projectRoutes.openapi(peopleRoute, async (c) => {
  const { id } = c.req.valid("param");
  const people = await listProjectPeople({
    principal: c.get("principal"),
    projectId: id,
  });
  return c.json({ people }, 200);
});

projectRoutes.openapi(conversationsRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { search, limit } = c.req.valid("query");
  const data = await listProjectConversations({
    principal: c.get("principal"),
    projectId: id,
    ...(search === undefined ? {} : { search }),
    ...(limit === undefined ? {} : { limit }),
  });
  return c.json({ data }, 200);
});

export { projectRoutes };
