import type { Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import db from "../db";
import type { HonoLoggedAppType } from "../lib/auth-middleware";
import { forbidden, throwHttpError } from "../lib/errors";
import type { AccessLevel } from "../schemas/access";
import {
  type EngineResourceType,
  requireAccess,
  type ResolvedResource,
} from "./access";
import type { Capability } from "./capabilities";
import { requireCapability } from "./gates";
import { throwNotVisible } from "./refusals";

/**
 * Every route says who may call it — and saying it is what enforces it.
 *
 * A route declares ONE rule by putting one of the `access.*` middlewares
 * below in its chain (`createRoute({ middleware: access.resource(…) })`, or
 * before the handler of a plain route). Each middleware both performs its
 * check and carries its rule as data, which is what the coverage test of each
 * service reads (`tests/unit/route-access.test.ts`): a route with no rule
 * fails the build, so "forgot to check" is no longer something a review has
 * to catch.
 *
 * Pass the rule to `createRoute` bare, not in an array: the router types the
 * handler's context from a single middleware (or a tuple), and an array
 * literal loses that — `c.get("resource")` would no longer be typed.
 *
 * The rules, from the most to the least specific:
 *
 *   resource    one resource named in the path; loaded, decided, and handed to
 *               the handler as `c.get("resource")`. 404 when invisible, 403
 *               with the reason when the level is short.
 *   capability  an action gated by role and policy (`capabilities.ts`),
 *               decided in the active team for a team capability — or, with
 *               `teamCapability`, in the team the path names.
 *   session     any member of the organization; the service scopes what it
 *               returns to the principal (lists, "my" things, creation in the
 *               active team). The note says how.
 *   handler     decided in the handler because it involves several resources
 *               or ids from the body. The reason says what is checked, and
 *               where.
 *   operator    platform operators (super-admins) only.
 *   internal    another service of ours, behind a shared key or a signed
 *               callback — never a browser. The reason names the caller and
 *               what it vouches for.
 *   public      no session at all, on purpose. The reason is the decision.
 */

export type AccessRule =
  | {
      readonly kind: "resource";
      readonly type: EngineResourceType;
      readonly level: AccessLevel;
      readonly param: string;
    }
  | {
      readonly kind: "capability";
      readonly capability: Capability;
      /** Set when decided in the team named by this path parameter. */
      readonly param?: string;
    }
  | { readonly kind: "session"; readonly note: string }
  | { readonly kind: "handler"; readonly reason: string }
  | { readonly kind: "operator" }
  | { readonly kind: "internal"; readonly reason: string }
  | { readonly kind: "public"; readonly reason: string };

const ACCESS_RULE = Symbol.for("fretik.authz.access-rule");

type RuleCarrier = { [ACCESS_RULE]?: AccessRule };

const withRule = <T extends object>(handler: T, rule: AccessRule): T =>
  Object.assign(handler, { [ACCESS_RULE]: rule });

/** The rule a route handler carries, if it is one of the `access.*` middlewares. */
export const accessRuleOf = (handler: unknown): AccessRule | undefined =>
  typeof handler === "function"
    ? (handler as RuleCarrier)[ACCESS_RULE]
    : undefined;

/** What a `resource` route's handler finds on the context. */
export type ResourceEnv = HonoLoggedAppType & {
  Variables: { resource: ResolvedResource };
};

/**
 * The team a `resource` route acts in: the resource's own, never the one the
 * caller has open. A resource named by id is the same resource from every
 * team, and one shared across teams opens, and changes at the level shared,
 * wherever its link is followed: the engine has already decided the caller
 * may. Only creating something happens in the active team.
 */
export const teamOfResource = (resource: ResolvedResource): string =>
  // Every type a `resource` route names lives in a team; one that did not
  // would have no team-scoped service behind it.
  resource.node.teamId ?? throwNotVisible();

const uuid = z.uuid();

/** Whether `teamId` names a team of this organization. */
const isOrganizationTeam = async (
  organizationId: string,
  teamId: string,
): Promise<boolean> => {
  if (!uuid.safeParse(teamId).success) return false;
  const row = await db.query.team.findFirst({
    columns: { id: true },
    where: { id: teamId, organizationId },
  });
  return row !== undefined;
};

/**
 * A rule decided elsewhere. Typed on Hono's blank `Env`, never left to
 * default: an untyped middleware carries `any` as its env, and the router
 * intersects it with the app's, so every `c.get(…)` in the handler would
 * silently become `any`.
 */
const passThrough = (): MiddlewareHandler<Env> =>
  createMiddleware<Env>(async (_c, next) => {
    await next();
  });

export const access = {
  /**
   * One resource named in the path (`param`, `id` by default): 404 when the
   * caller cannot see it, 403 with the reason when their level is short. The
   * handler finds it on `c.get("resource")` — the node (its team, its owner)
   * and the caller's level on it.
   */
  resource: (
    type: EngineResourceType,
    level: AccessLevel,
    param = "id",
  ): MiddlewareHandler<ResourceEnv> =>
    withRule(
      createMiddleware<ResourceEnv>(async (c, next) => {
        const resolved = await requireAccess({
          principal: c.get("principal"),
          type,
          id: c.req.param(param) ?? "",
          required: level,
        });
        c.set("resource", resolved);
        await next();
      }),
      { kind: "resource", type, level, param },
    ),

  /** A capability, decided in the caller's active team when it is a team one. */
  capability: (capability: Capability): MiddlewareHandler<HonoLoggedAppType> =>
    withRule(
      createMiddleware<HonoLoggedAppType>(async (c, next) => {
        await requireCapability({
          principal: c.get("principal"),
          capability,
          teamId: c.get("team")?.id ?? null,
        });
        await next();
      }),
      { kind: "capability", capability },
    ),

  /**
   * A team capability decided in the team NAMED IN THE PATH (`param`, `id` by
   * default), not the active one: a team's settings are managed from
   * anywhere. A team of another organization answers 404, like one that does
   * not exist — before any role is looked at, so a refusal never names
   * another organization's leads.
   */
  teamCapability: (
    capability: Capability,
    param = "id",
  ): MiddlewareHandler<HonoLoggedAppType> =>
    withRule(
      createMiddleware<HonoLoggedAppType>(async (c, next) => {
        const principal = c.get("principal");
        const teamId = c.req.param(param) ?? "";
        if (!(await isOrganizationTeam(principal.organizationId, teamId))) {
          throwNotVisible("Team not found");
        }
        await requireCapability({ principal, capability, teamId });
        await next();
      }),
      { kind: "capability", capability, param },
    ),

  /** Any member; `note` says how the service scopes the answer. */
  session: (note: string): MiddlewareHandler<Env> =>
    withRule(passThrough(), { kind: "session", note }),

  /** Decided in the handler; `reason` says what is checked and where. */
  handler: (reason: string): MiddlewareHandler<Env> =>
    withRule(passThrough(), { kind: "handler", reason }),

  /** Platform operators only. Mount after the session middleware. */
  operator: (): MiddlewareHandler<HonoLoggedAppType> =>
    withRule(
      createMiddleware<HonoLoggedAppType>(async (c, next) => {
        if (!c.get("user").isSuperAdmin) {
          throwHttpError(403, forbidden("Operators only"));
        }
        await next();
      }),
      { kind: "operator" },
    ),

  /**
   * Another service of ours. The key or signature is checked by the router's
   * own middleware (`internalMiddleware`, the trigger callback's); `reason`
   * names the caller and what it vouches for.
   */
  internal: (reason: string): MiddlewareHandler<Env> =>
    withRule(passThrough(), { kind: "internal", reason }),

  /** No session, on purpose; `reason` is that decision. */
  public: (reason: string): MiddlewareHandler<Env> =>
    withRule(passThrough(), { kind: "public", reason }),
};
