import { type HonoLoggedAppType } from "@fretik/shared/lib/auth-middleware";
import { responseInternalErrorSchema } from "@fretik/shared/schemas/common/responses";
import { desktopReleaseResponseSchema } from "@fretik/shared/schemas/desktop-releases";
import { getLatestDesktopRelease } from "@fretik/shared/services/desktop-releases/get-latest";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * Public "latest desktop release" lookup — powers the unauthenticated
 * `/download` marketing page. Intentionally UNAUTHENTICATED (no
 * `authMiddleware`, mirrors `public-forms.ts`): anyone visiting the download
 * page, logged in or not, needs this.
 */
const desktopReleaseRoutes = new OpenAPIHono<HonoLoggedAppType>();

const getLatestRoute = createRoute({
  method: "get",
  path: "/latest",
  summary: "Latest desktop app release — version + per-platform download URLs",
  tags: ["Desktop"],
  responses: {
    200: {
      content: { "application/json": { schema: desktopReleaseResponseSchema } },
      description:
        "Latest release info (`available: false` if the feed isn't configured)",
    },
    ...responseInternalErrorSchema,
  },
});

desktopReleaseRoutes.openapi(getLatestRoute, async (c) => {
  const release = await getLatestDesktopRelease();
  return c.json(release, 200);
});

export { desktopReleaseRoutes };
