import { access } from "@fretik/shared/authz/http";
import {
  type HonoSessionAppType,
  sessionMiddleware,
} from "@fretik/shared/lib/auth-middleware";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import { workspacesSchema } from "@fretik/shared/schemas/workspaces";
import { listWorkspaces } from "@fretik/shared/services/workspaces/list-workspaces";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * Where the signed-in person can work: every organization they belong to,
 * their role and teams in each, and the invitations waiting for their
 * answer. The app's workspace switcher reads it, and so does its setup page,
 * where no organization is open yet: this router asks for a session only
 * (`sessionMiddleware`), never an active organization.
 */
const workspaceRoutes = new OpenAPIHono<HonoSessionAppType>();
workspaceRoutes.use("*", sessionMiddleware);

const listRoute = createRoute({
  method: "get",
  path: "/",
  middleware: access.session(
    "The caller's own memberships, and the invitations addressed to their verified email; no organization's content.",
  ),
  summary: "The organizations I belong to, and the invitations waiting for me",
  tags: ["Workspaces"],
  responses: {
    200: {
      content: { "application/json": { schema: workspacesSchema } },
      description: "My memberships, and the invitations still pending",
    },
    ...responseInternalErrorSchema,
  },
});

workspaceRoutes.openapi(listRoute, async (c) => {
  const user = c.get("user");
  const workspaces = await listWorkspaces({
    userId: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
  });
  return c.json(workspaces, 200);
});

export { workspaceRoutes };
