import { createMiddleware } from "hono/factory";
import db from "../db";
import type { organization, team, user } from "../db/schema";
import { auth } from "./auth";
import {
  TEAM_MEMBERSHIP_CACHE_TTL,
  teamMembershipCacheKey,
} from "./auth-roles";
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
      const candidate = await selectOrCache(
        () =>
          db.query.team.findFirst({
            where: { id: activeTeamId },
          }),
        `team:${activeTeamId}`,
      );

      // The session keeps its `activeTeamId` when the active organization
      // changes, and team membership can be revoked mid-session. Trusting the
      // raw id would run the request against a team the caller has no access
      // to — leave the context team null instead, so handlers that need one
      // fail cleanly rather than serving another team's data.
      const belongsToActiveOrg = candidate?.organizationId === activeOrgId;
      if (candidate && belongsToActiveOrg) {
        const membership = await selectOrCache(
          () =>
            db.query.teamMember.findFirst({
              where: { teamId: activeTeamId, userId: authUser.id },
            }),
          teamMembershipCacheKey(activeTeamId, authUser.id),
          TEAM_MEMBERSHIP_CACHE_TTL,
        );
        if (membership) {
          activeTeam = candidate;
        }
      }
    }

    c.set("user", authUser as typeof user.$inferSelect);
    c.set("session", authSession);
    c.set("organization", org);
    c.set("team", activeTeam ?? null);

    await next();
  },
);

/**
 * Gate for platform-operator (super-admin) endpoints. Mount AFTER
 * `authMiddleware` — it reads the `isSuperAdmin` flag off the typed user. The
 * flag is an immutable `user` column (never derived from the email), so this
 * check cannot be bypassed by changing or spoofing an email.
 */
export const superAdminMiddleware = createMiddleware<HonoLoggedAppType>(
  async (c, next) => {
    if (!c.get("user").isSuperAdmin) {
      return c.json({ message: "Forbidden", code: "FORBIDDEN" }, 403);
    }
    await next();
  },
);
