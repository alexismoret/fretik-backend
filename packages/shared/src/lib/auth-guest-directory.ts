import { z } from "zod";
import { parseOrganizationRole } from "../authz/load-principal";
import db from "../db";

/**
 * A guest does not read the organization's directory.
 *
 * Our own routes decide that through the engine (`directory.read` refuses a
 * guest). Better Auth's organization plugin has endpoints of its own that
 * list an organization's people, teams and invitations to ANY member, and it
 * has no notion of a guest. So their answers are cut down here, after the
 * plugin has run its own checks: a guest sees themselves in the
 * organization, and none of its people, teams or pending invitations. Cut
 * down rather than refused, because the app reads the active organization on
 * every page (`get-full-organization`) for its name and logo, which a guest
 * may see.
 *
 * Every answer that is not a guest's passes untouched, and so does an error.
 */

/** The organization endpoints that list who and what is in it. */
const DIRECTORY_PATHS = new Set([
  "/organization/get-full-organization",
  "/organization/list-members",
  "/organization/list-invitations",
  "/organization/list-teams",
  "/organization/list-team-members",
]);

export const isDirectoryPath = (path: string): boolean =>
  DIRECTORY_PATHS.has(path);

const memberRowSchema = z.looseObject({
  userId: z.string(),
  role: z.string(),
});

const fullOrganizationSchema = z.looseObject({
  id: z.string(),
  members: z.array(memberRowSchema),
});

const memberListSchema = z.looseObject({
  members: z.array(memberRowSchema),
});

/**
 * Whether the caller is a guest of the organization: from their own row when
 * the answer lists it — most of the time, and then at no cost on a page
 * load — else from the database.
 */
const isGuestOf = async (
  organizationId: string,
  userId: string,
  listed: readonly { userId: string; role: string }[] = [],
): Promise<boolean> => {
  const own =
    listed.find((row) => row.userId === userId) ??
    (await db.query.member.findFirst({
      columns: { role: true },
      where: { organizationId, userId },
    }));
  return own !== undefined && parseOrganizationRole(own.role) === "guest";
};

/**
 * What a guest may see of one directory answer: themselves, and nothing else
 * of the organization's people, teams or invitations. Null when the answer
 * stands as it is — the caller is not a guest of that organization, or the
 * answer is not one this knows how to read.
 */
export const directoryAnswerForGuest = async (input: {
  path: string;
  returned: unknown;
  userId: string;
  /** The organization the request asked about, when the answer does not say. */
  organizationId: string | null;
}): Promise<Record<string, unknown> | unknown[] | null> => {
  const { path, returned, userId } = input;

  if (path === "/organization/get-full-organization") {
    const organization = fullOrganizationSchema.safeParse(returned);
    if (!organization.success) return null;
    const { id, members } = organization.data;
    if (!(await isGuestOf(id, userId, members))) return null;
    return {
      ...organization.data,
      members: organization.data.members.filter((row) => row.userId === userId),
      invitations: [],
      ...("teams" in organization.data ? { teams: [] } : {}),
    };
  }

  if (input.organizationId === null) return null;

  if (path === "/organization/list-members") {
    const list = memberListSchema.safeParse(returned);
    if (!list.success) return null;
    const { members } = list.data;
    if (!(await isGuestOf(input.organizationId, userId, members))) return null;
    const self = members.filter((row) => row.userId === userId);
    return { ...list.data, members: self, total: self.length };
  }
  if (!(await isGuestOf(input.organizationId, userId))) return null;
  // Invitations, teams and a team's members: none of a guest's business.
  return [];
};
