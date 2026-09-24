import {
  idsByTeam,
  requireAccessForEachResolved,
} from "@fretik/shared/authz/access";
import { requireDriveMove } from "@fretik/shared/authz/drive";
import { access, teamOfResource } from "@fretik/shared/authz/http";
import {
  requirePlacement,
  teamOfProject,
} from "@fretik/shared/authz/placement";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import { teamRequired, throwHttpError } from "@fretik/shared/lib/errors";
import {
  bodyIdListSchema,
  CreateFolderSchema,
  driveListParamsSchema,
  FolderDriveResponseSchema,
  FolderResponseSchema,
  UpdateFolderSchema,
} from "@fretik/shared/schemas";
import { paramsIdSchema } from "@fretik/shared/schemas/common/params";
import {
  responseBadRequestSchema,
  responseCreatedSchemaBuilder,
  responseForbiddenSchema,
  responseInternalErrorSchema,
  responseNotFoundSchema,
  responseSuccessDeletedSchema,
} from "@fretik/shared/schemas/common/responses";
import { createFolder } from "@fretik/shared/services/folders/create";
import { deleteFolders } from "@fretik/shared/services/folders/delete";
import {
  getFolder,
  getRootDrive,
} from "@fretik/shared/services/folders/retrieve";
import { updateFolder } from "@fretik/shared/services/folders/update";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

// ==================== //
// ROUTER SETUP         //
// ==================== //

/**
 * Each route on one folder names the level it takes (`access.resource`): view
 * to open it, edit to rename or move it, full to delete it — with everything
 * inside. Creating a folder, or moving one, also takes edit on the folder it
 * lands in.
 */
const folderRoutes = new OpenAPIHono<HonoLoggedAppType>();
folderRoutes.use("*", authMiddleware);

// ==================== //
// HELPERS              //
// ==================== //

// ==================== //
// ROUTE DEFINITIONS    //
// ==================== //

const createFolderRoute = createRoute({
  method: "post",
  path: "",
  middleware: access.handler(
    "Where it lands (`authz/placement.ts`): edit on its parent, taking part in its project, or contributing to the active team at its root.",
  ),
  summary: "Create a folder",
  description: "Create a new folder",
  tags: ["Folders"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: CreateFolderSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    ...responseCreatedSchemaBuilder(FolderResponseSchema, "folder created"),
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getRootDriveRoute = createRoute({
  method: "get",
  path: "",
  middleware: access.session(
    "The root of the active team's Drive, or of a project the caller reaches (`projectId`, view on it); only what the caller can open (authz/drive-sql).",
  ),
  summary: "Get root drive",
  description:
    "Get root folder details and its children: the active team's root (what is in no project), or a project's (`projectId`).",
  tags: ["Folders"],
  request: {
    query: driveListParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: FolderDriveResponseSchema,
        },
      },
      description: "Root drive details, children and breadcrumbs",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const getFolderExplorerRoute = createRoute({
  method: "get",
  path: "/{id}",
  middleware: access.resource("folder", "view"),
  summary: "Get a folder explorer",
  description: "Get a specific folder details and its children",
  tags: ["Folders"],
  request: {
    params: paramsIdSchema,
    query: driveListParamsSchema,
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: FolderDriveResponseSchema,
        },
      },
      description: "Folder details, children and breadcrumbs",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const updateFolderRoute = createRoute({
  method: "patch",
  path: "/{id}",
  middleware: access.resource("folder", "edit"),
  summary: "Update a folder",
  description: "Update a specific folder by ID",
  tags: ["Folders"],
  request: {
    params: paramsIdSchema,
    body: {
      content: {
        "application/json": {
          schema: UpdateFolderSchema,
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: FolderResponseSchema,
        },
      },
      description: "Folder updated",
    },
    ...responseNotFoundSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const deleteFoldersRoute = createRoute({
  method: "delete",
  path: "",
  middleware: access.handler(
    "Each folder takes full access, and is deleted in its own team; ids out of sight are skipped (requireAccessForEachResolved).",
  ),
  summary: "Delete multiple folders",
  description: "Delete multiple folders by ID",
  tags: ["Folders"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: bodyIdListSchema,
        },
      },
    },
  },
  responses: {
    ...responseSuccessDeletedSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

// ==================== //
// ROUTE HANDLERS       //
// ==================== //

folderRoutes.openapi(createFolderRoute, async (c) => {
  const user = c.get("user");
  const { name, parentFolderId, projectId } = c.req.valid("json");
  const placement = await requirePlacement({
    principal: c.get("principal"),
    activeTeamId: c.get("team")?.id,
    folderId: parentFolderId,
    projectId,
  });

  const newFolder = await createFolder({
    name,
    parentFolderId,
    teamId: placement.teamId,
    projectId: placement.projectId,
    userId: user.id,
    actor: { actorType: "user", actorUserId: user.id },
  });

  return c.json(newFolder, 201);
});

folderRoutes.openapi(getRootDriveRoute, async (c) => {
  const principal = c.get("principal");
  const params = c.req.valid("query");

  // A project's root is in its team's Drive, reached through the project.
  if (params.projectId !== undefined) {
    const result = await getRootDrive({
      principal,
      teamId: await teamOfProject(principal, params.projectId),
      projectId: params.projectId,
      params,
    });
    return c.json({ ...result, level: null }, 200);
  }

  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());
  const result = await getRootDrive({
    principal,
    teamId: team.id,
    projectId: null,
    params,
  });

  return c.json({ ...result, level: null }, 200);
});

folderRoutes.openapi(getFolderExplorerRoute, async (c) => {
  const resource = c.get("resource");

  const { id } = c.req.valid("param");
  const params = c.req.valid("query");

  const result = await getFolder({
    principal: c.get("principal"),
    folderId: id,
    teamId: teamOfResource(resource),
    params,
  });

  return c.json({ ...result, level: resource.level }, 200);
});

folderRoutes.openapi(updateFolderRoute, async (c) => {
  const user = c.get("user");
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");
  if (updates.parentFolderId !== undefined) {
    await requireDriveMove(c.get("principal"), {
      type: "folder",
      id,
      folderId: updates.parentFolderId,
    });
  }

  const updatedFolder = await updateFolder({
    id,
    teamId,
    updates,
    actor: { actorType: "user", actorUserId: user.id },
  });

  return c.json(updatedFolder, 200);
});

folderRoutes.openapi(deleteFoldersRoute, async (c) => {
  const user = c.get("user");
  const { ids } = c.req.valid("json");
  const deletable = await requireAccessForEachResolved({
    principal: c.get("principal"),
    type: "folder",
    ids,
    required: "full",
  });

  // Each in its own team: a selection made in a folder shared from another
  // team is that team's.
  let rowCount = 0;
  for (const [teamId, teamIds] of idsByTeam(deletable)) {
    // oxlint-disable-next-line no-await-in-loop -- one team, rarely two
    const res = await deleteFolders({
      ids: teamIds,
      teamId,
      actor: { actorType: "user", actorUserId: user.id },
    });
    rowCount += res.rowCount ?? 0;
  }

  return c.json({ rowCount }, 200);
});

export { folderRoutes };
