import { access } from "@fretik/shared/authz/http";
import {
  authMiddleware,
  type HonoLoggedAppType,
} from "@fretik/shared/lib/auth-middleware";
import {
  changelogSeenResponseSchema,
  markChangelogSeenRequestSchema,
  markChangelogSeenResponseSchema,
} from "@fretik/shared/schemas/changelog";
import {
  responseBadRequestSchema,
  responseForbiddenSchema,
  responseInternalErrorSchema,
} from "@fretik/shared/schemas/common/responses";
import {
  listSeenChangelogSlugs,
  markChangelogSeen,
} from "@fretik/shared/services/changelog/seen";
import { createRoute, OpenAPIHono } from "@hono/zod-openapi";

/**
 * Product-update read receipts.
 *
 * This service serves no changelog CONTENT and has no route that could: the
 * updates are reviewed files in the frontend repo, shipped with the client
 * (see `db/schema/changelog-reads.ts` for why). All that crosses the wire here
 * is which entries the caller has already been shown, so the same
 * announcement does not follow them from their laptop to their desktop.
 *
 * Scoped to the caller from the session — no route names whose receipts it is
 * touching, so there is nothing to authorise beyond being signed in.
 */
const changelogRoutes = new OpenAPIHono<HonoLoggedAppType>();
changelogRoutes.use("*", authMiddleware);

const listSeenRoute = createRoute({
  method: "get",
  path: "/seen",
  middleware: access.session("The caller reads their own read receipts."),
  summary: "Product updates the caller has already been shown",
  description:
    "The full set of slugs, unordered. The client diffs it against the entries it ships to decide what — if anything — to announce.",
  tags: ["Changelog"],
  responses: {
    200: {
      content: { "application/json": { schema: changelogSeenResponseSchema } },
      description: "Seen slugs",
    },
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

const markSeenRoute = createRoute({
  method: "post",
  path: "/seen",
  middleware: access.session(
    "The caller marks updates as seen for themselves.",
  ),
  summary: "Mark product updates as shown to the caller",
  description:
    "Idempotent: re-sending a slug keeps its original timestamp and counts as 0 added, so a retry or a second tab is harmless. Unknown slugs are accepted — the frontend is the only authority on which entries exist, and it may ship before or after this service.",
  tags: ["Changelog"],
  request: {
    body: {
      content: {
        "application/json": { schema: markChangelogSeenRequestSchema },
      },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: markChangelogSeenResponseSchema },
      },
      description: "Recorded",
    },
    ...responseBadRequestSchema,
    ...responseForbiddenSchema,
    ...responseInternalErrorSchema,
  },
});

changelogRoutes.openapi(listSeenRoute, async (c) => {
  const user = c.get("user");
  const slugs = await listSeenChangelogSlugs(user.id);
  return c.json({ slugs }, 200);
});

changelogRoutes.openapi(markSeenRoute, async (c) => {
  const user = c.get("user");
  const { slugs } = c.req.valid("json");
  const added = await markChangelogSeen({ userId: user.id, slugs });
  return c.json({ added }, 200);
});

export { changelogRoutes };
