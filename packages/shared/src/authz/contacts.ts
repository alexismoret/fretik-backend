import { and, eq, inArray, sql } from "drizzle-orm";
import db from "../db";
import { accessGrants, member, teamMemberRoles, user } from "../db/schema";
import type { AccessContact, AccessResourceType } from "../schemas/access";

/**
 * "Who can I ask?" — the people a refusal names.
 *
 * A refusal that says only "no" leaves the person stuck; one that names
 * someone who can say yes is a next step. The order goes from the closest to
 * the resource to the most general, and stops as soon as it has someone:
 *
 *   resource: its owner, then people with full access to it, then the leads
 *             of its team, then the organization's admins;
 *   capability in a team: the team's leads, then the admins;
 *   capability of the organization: the admins.
 *
 * Everyone named is a current member of the organization — an owner who left
 * cannot approve anything. At most `MAX_CONTACTS`, so a refusal stays short.
 */

const MAX_CONTACTS = 3;

interface Person {
  id: string;
  name: string;
  image: string | null;
}

/** Keep the people of `ids` who still belong to the organization, in order. */
const currentMembers = async (
  organizationId: string,
  ids: string[],
): Promise<Person[]> => {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, unique),
        // The team agent is a member on paper; it approves nothing.
        sql`${member.role} <> 'bot'`,
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique.flatMap((id) => {
    const person = byId.get(id);
    return person ? [person] : [];
  });
};

const teamLeadIds = async (teamId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: teamMemberRoles.userId })
    .from(teamMemberRoles)
    .where(
      and(eq(teamMemberRoles.teamId, teamId), eq(teamMemberRoles.role, "lead")),
    )
    .limit(MAX_CONTACTS);
  return rows.map((row) => row.userId);
};

const adminIds = async (organizationId: string): Promise<string[]> => {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.role, ["owner", "admin"]),
      ),
    )
    // Owners first: they are the ones every organization has.
    .orderBy(sql`${member.role} = 'owner' DESC`, member.createdAt)
    .limit(MAX_CONTACTS);
  return rows.map((row) => row.userId);
};

const toContacts = (
  people: Person[],
  reason: AccessContact["reason"],
): AccessContact[] =>
  people.map((person) => ({
    userId: person.id,
    name: person.name,
    image: person.image,
    reason,
  }));

/** Who can open a resource to the person refused on it. */
export const resourceContacts = async (input: {
  organizationId: string;
  resourceType: AccessResourceType;
  resourceId: string;
  ownerUserId: string | null;
  teamId: string | null;
  /** Never name the person who is asking. */
  excludeUserId: string;
}): Promise<AccessContact[]> => {
  const without = (ids: string[]) =>
    ids.filter((id) => id !== input.excludeUserId);

  const contacts: AccessContact[] = [];
  if (input.ownerUserId !== null) {
    const owner = await currentMembers(
      input.organizationId,
      without([input.ownerUserId]),
    );
    contacts.push(...toContacts(owner, "owner"));
  }

  const fullAccess = await db
    .select({ userId: accessGrants.principalId })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.resourceType, input.resourceType),
        eq(accessGrants.resourceId, input.resourceId),
        eq(accessGrants.principalType, "user"),
        eq(accessGrants.level, "full"),
      ),
    )
    .limit(MAX_CONTACTS);
  const holders = await currentMembers(
    input.organizationId,
    without(fullAccess.map((row) => row.userId)).filter(
      (id) => id !== input.ownerUserId,
    ),
  );
  contacts.push(...toContacts(holders, "full_access"));
  if (contacts.length > 0) return contacts.slice(0, MAX_CONTACTS);

  return capabilityContacts({
    organizationId: input.organizationId,
    teamId: input.teamId,
    excludeUserId: input.excludeUserId,
  });
};

/**
 * Who can grant a capability: the team's leads for a team capability, the
 * organization's admins otherwise — and the admins as the last resort of a
 * team with no lead.
 */
export const capabilityContacts = async (input: {
  organizationId: string;
  teamId: string | null;
  excludeUserId: string;
}): Promise<AccessContact[]> => {
  const without = (ids: string[]) =>
    ids.filter((id) => id !== input.excludeUserId);

  if (input.teamId !== null) {
    const leads = await currentMembers(
      input.organizationId,
      without(await teamLeadIds(input.teamId)),
    );
    if (leads.length > 0) return toContacts(leads, "team_lead");
  }
  const admins = await currentMembers(
    input.organizationId,
    without(await adminIds(input.organizationId)),
  );
  return toContacts(admins, "admin");
};
