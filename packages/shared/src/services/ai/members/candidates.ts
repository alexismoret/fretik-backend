import { inArray } from "drizzle-orm";
import { projectParticipants } from "../../../authz/project-people";
import type { LoadedNode } from "../../../authz/resources/types";
import db from "../../../db";
import { user } from "../../../db/schema";
import { listTeamMembers, type TeamMember } from "../../team/members";

/**
 * Of these people, the ones who may take part in a chat: those who work where
 * it lives — its project's participants when it is in one, whatever their
 * team, else the people of its team (`authz/rules.ts`, `levelCeiling`). Its
 * team's agent is never one. Returned with what a roster or a mention email
 * shows of them.
 */
export const takingPartCandidates = async (
  node: LoadedNode,
  userIds: readonly string[],
): Promise<TeamMember[]> => {
  const wanted = [...new Set(userIds)];
  if (wanted.length === 0) return [];

  if (node.projectId !== null) {
    const participants = await projectParticipants({
      organizationId: node.organizationId,
      projectId: node.projectId,
      userIds: wanted,
    });
    if (participants.size === 0) return [];
    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
      })
      .from(user)
      .where(inArray(user.id, [...participants]));
    return rows;
  }

  if (node.teamId === null) return [];
  const asked = new Set(wanted);
  return (await listTeamMembers(node.teamId)).filter((person) =>
    asked.has(person.userId),
  );
};
