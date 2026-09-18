import { type HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import { getPublicInvitationPreview } from "@fretik/shared/services/invitations/get-public-preview";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

/**
 * Public invitation endpoints. The `/preview` route is intentionally
 * UNAUTHENTICATED (no `authMiddleware`) so a logged-out invitee can see who
 * invited them — org, team, person — before signing up or signing in.
 * Accepting / rejecting an invitation still goes through Better Auth's
 * authenticated organization endpoints.
 *
 * `hasAccount` / `alreadyMember` answer for the ONE address the invitation was
 * mailed to, to whoever holds that mailed link — see the service for why that
 * is not an enumeration oracle. They let the landing page open on the right
 * form instead of walking an existing account into a sign-up that cannot work.
 */
const invitationRoutes = new OpenAPIHono<HonoLoggedAppType>();

const previewResponseSchema = z.object({
  found: z.boolean(),
  status: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional(),
  organizationName: z.string().optional(),
  organizationLogo: z.string().nullable().optional(),
  inviterName: z.string().optional(),
  inviterImage: z.string().nullable().optional(),
  teamName: z.string().nullable().optional(),
  expiresAt: z.date().optional(),
  hasAccount: z.boolean().optional(),
  alreadyMember: z.boolean().optional(),
});

const previewRoute = createRoute({
  method: "get",
  path: "/{id}/preview",
  summary: "Public preview of an organization invitation",
  tags: ["Invitations"],
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      content: {
        "application/json": { schema: previewResponseSchema },
      },
      description: "Invitation preview (found:false when missing or invalid)",
    },
    ...responseInternalErrorSchema,
  },
});

invitationRoutes.openapi(previewRoute, async (c) => {
  const { id } = c.req.valid("param");
  const preview = await getPublicInvitationPreview(id);
  return c.json(preview, 200);
});

export { invitationRoutes };
