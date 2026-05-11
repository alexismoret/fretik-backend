import { createMiddleware } from "hono/factory";
import db from "../db";
import type { organization, team, user } from "../db/schema";
import { auth } from "./auth";
import { selectOrCache } from "./redis";

export type HonoLoggedAppType = {
  Variables: {
    user: typeof user.$inferSelect;
    session: typeof auth.$Infer.Session.session;
    organization: typeof organization.$inferSelect;
    team: typeof team.$inferSelect | null;
  };
};

/**
 * Handles Better Auth session and populates organization/team context.
 * Shared between @fretik/api and @fretik/ai — any service that reads the
 * `fretik-*` cookie gets identical behavior and typed context variables.
 */
export const authMiddleware = createMiddleware<HonoLoggedAppType>(
  async (c, next) => {
    const sessionData = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (!sessionData) {
      return c.json({ message: "Unauthorized" }, 401);
    }

    const { user: authUser, session: authSession } = sessionData;

    const activeOrgId = authSession.activeOrganizationId;
    if (!activeOrgId) {
      return c.json(
        {
          message: "No active organization found in session",
          code: "ORGANIZATION_REQUIRED",
        },
        403,
      );
    }

    const org = await selectOrCache(
      () =>
        db.query.organization.findFirst({
          where: { id: activeOrgId },
        }),
      `organization:${activeOrgId}`,
    );
    if (!org) {
      return c.json(
        {
          message: "Active organization not found in database",
          code: "ORGANIZATION_NOT_FOUND",
        },
        404,
      );
    }

    const activeTeamId = authSession.activeTeamId;
    let activeTeam: typeof team.$inferSelect | undefined = undefined;

    if (activeTeamId) {
      activeTeam = await selectOrCache(
        () =>
          db.query.team.findFirst({
            where: { id: activeTeamId },
          }),
        `team:${activeTeamId}`,
      );
    }

    c.set("user", authUser as typeof user.$inferSelect);
    c.set("session", authSession);
    c.set("organization", org);
    c.set("team", activeTeam ?? null);

    await next();
  },
);
