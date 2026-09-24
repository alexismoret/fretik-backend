import { inArray } from "drizzle-orm";
import db from "../../db";
import {
  aiConversationMembers,
  aiConversations,
  workflowRuns,
} from "../../db/schema";
import type { GrantFact } from "../principal";
import { workflowAdapter } from "./content";
import { loadExplicitGrants, mergeGrants } from "./grants";
import type { LoadedNode, ResourceAdapter } from "./types";

/**
 * Conversations.
 *
 * A chat's participants are its SEATS (`ai_conversation_members`): the owner
 * has full access, every other participant takes part (`use`). It can also be
 * given to read (`view`) through a grant, to people, teams, projects or the
 * whole organization; taking part is always a person's seat, and only for the
 * people who work where it lives — its project's, when it is in one, else its
 * team's (`levelCeiling`). A chat is private to the people it is given to
 * unless it is opened to its container — then everyone in the project (or
 * team) can read it.
 *
 * A workflow run's conversation has no seats: it belongs to its workflow, and
 * reads through it (`parent`), capped at `view` like any inherited access to a
 * conversation (`rules.ts`).
 */
export const conversationAdapter: ResourceAdapter = {
  type: "conversation",
  offeredLevels: ["view", "use"],
  groupLevels: ["view"],
  shareablePrincipals: ["user", "team", "project", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const rows = await executor
      .select({
        id: aiConversations.id,
        organizationId: aiConversations.organizationId,
        teamId: aiConversations.teamId,
        projectId: aiConversations.projectId,
        creatorId: aiConversations.userId,
        restricted: aiConversations.accessRestricted,
        agentType: aiConversations.agentType,
        title: aiConversations.title,
      })
      .from(aiConversations)
      .where(inArray(aiConversations.id, unique));
    if (rows.length === 0) return new Map();
    const rowIds = rows.map((row) => row.id);

    const [seats, explicit, runs] = await Promise.all([
      executor
        .select({
          conversationId: aiConversationMembers.conversationId,
          userId: aiConversationMembers.userId,
          role: aiConversationMembers.role,
        })
        .from(aiConversationMembers)
        .where(inArray(aiConversationMembers.conversationId, rowIds)),
      loadExplicitGrants("conversation", rowIds, executor),
      executor
        .select({
          conversationId: workflowRuns.conversationId,
          workflowId: workflowRuns.workflowId,
        })
        .from(workflowRuns)
        .where(inArray(workflowRuns.conversationId, rowIds)),
    ]);

    const owners = new Map<string, string>();
    const grants = explicit;
    for (const seat of seats) {
      if (seat.role === "owner") owners.set(seat.conversationId, seat.userId);
      const grant: GrantFact = {
        principalType: "user",
        principalId: seat.userId,
        level: seat.role === "owner" ? "full" : "use",
      };
      mergeGrants(grants, seat.conversationId, [grant]);
    }

    const workflowOf = new Map(
      runs.flatMap((run) =>
        run.conversationId === null
          ? []
          : [[run.conversationId, run.workflowId] as const],
      ),
    );
    const workflowNodes = await workflowAdapter.loadNodes(
      [...new Set(workflowOf.values())],
      executor,
    );

    return new Map(
      rows.map((row) => {
        const workflowId = workflowOf.get(row.id);
        const workflow =
          row.agentType === "workflow" && workflowId !== undefined
            ? (workflowNodes.get(workflowId) ?? null)
            : null;
        const node: LoadedNode = {
          type: "conversation",
          id: row.id,
          organizationId: row.organizationId,
          teamId: row.teamId,
          projectId: row.projectId,
          // A run's conversation has no owner of its own: it is the
          // workflow's, and whoever reads the workflow reads the run.
          ownerUserId:
            row.agentType === "workflow"
              ? null
              : (owners.get(row.id) ?? row.creatorId),
          restricted: workflow === null ? row.restricted : false,
          grants: grants.get(row.id) ?? [],
          parent: workflow,
          name: row.title,
        };
        return [row.id, node] as const;
      }),
    );
  },
};
