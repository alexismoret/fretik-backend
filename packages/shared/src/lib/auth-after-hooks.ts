import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { z } from "zod";
import {
  directoryAnswerForGuest,
  isDirectoryPath,
} from "./auth-guest-directory";
import { onMemberLeftOrganization } from "./auth-membership";

/**
 * Better Auth `after` hooks: what runs once one of its endpoints has answered.
 *
 *   - `/organization/leave` is the one membership change with no organization
 *     hook: leaving on one's own is treated like being removed
 *     (`auth-membership.ts`);
 *   - the endpoints that list an organization's people, teams and
 *     invitations answer a guest with themselves alone
 *     (`auth-guest-directory.ts`).
 *
 * Both act only on an endpoint that succeeded: a refusal passes untouched.
 */

/** The shape `/organization/leave` answers with: the member row that left. */
const leftMemberSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
});

const organizationIdQuerySchema = z.looseObject({
  organizationId: z.string().optional(),
});

export const organizationAfterHooks = createAuthMiddleware(async (ctx) => {
  const returned: unknown = ctx.context.returned;
  if (returned instanceof APIError) return undefined;

  if (isDirectoryPath(ctx.path)) {
    const session = await getSessionFromCtx(ctx);
    if (!session) return undefined;
    const query = organizationIdQuerySchema.safeParse(ctx.query ?? {});
    const activeOrganizationId: unknown =
      "activeOrganizationId" in session.session
        ? session.session.activeOrganizationId
        : null;
    const trimmed = await directoryAnswerForGuest({
      path: ctx.path,
      returned,
      userId: session.user.id,
      organizationId:
        (query.success ? query.data.organizationId : undefined) ??
        (typeof activeOrganizationId === "string"
          ? activeOrganizationId
          : null),
    });
    return trimmed === null ? undefined : ctx.json(trimmed);
  }

  if (ctx.path === "/organization/leave") {
    const left = leftMemberSchema.safeParse(returned);
    if (left.success) await onMemberLeftOrganization(left.data);
  }
  return undefined;
});
