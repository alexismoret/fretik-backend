import {
  idsByTeam,
  requireAccessForEachResolved,
} from "@fretik/shared/authz/access";
import { requireFolderToAddTo } from "@fretik/shared/authz/drive";
import { access, teamOfResource } from "@fretik/shared/authz/http";
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
  middleware: access.capability("team.content.create"),
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
    "The root of the active team's Drive, only what the caller can open (authz/drive-sql).",
  ),
  summary: "Get root drive",
  description: "Get root folder details and its children",
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
  const team = c.get("team");

  // Require active team
  if (!team) {
    return throwHttpError(403, teamRequired());
  }

  // Get input
  const { name, parentFolderId } = c.req.valid("json");
  await requireFolderToAddTo(c.get("principal"), parentFolderId);

  const newFolder = await createFolder({
    name,
    parentFolderId,
    teamId: team.id,
    userId: user.id,
    actor: { actorType: "user", actorUserId: user.id },
  });

  return c.json(newFolder, 201);
});

folderRoutes.openapi(getRootDriveRoute, async (c) => {
  const team = c.get("team");
  if (!team) return throwHttpError(403, teamRequired());

  const params = c.req.valid("query");

  const result = await getRootDrive({
    principal: c.get("principal"),
    teamId: team.id,
    params,
  });

  return c.json(result, 200);
});

folderRoutes.openapi(getFolderExplorerRoute, async (c) => {
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const params = c.req.valid("query");

  const result = await getFolder({
    principal: c.get("principal"),
    folderId: id,
    teamId,
    params,
  });

  return c.json(result, 200);
});

folderRoutes.openapi(updateFolderRoute, async (c) => {
  const user = c.get("user");
  const teamId = teamOfResource(c.get("resource"));

  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");
  await requireFolderToAddTo(c.get("principal"), updates.parentFolderId);

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
