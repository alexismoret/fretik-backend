import { inArray } from "drizzle-orm";
import db from "../../db";
import { collectionGrants, collections, projects } from "../../db/schema";
import type { GrantFact } from "../principal";
import { loadExplicitGrants, mergeGrants } from "./grants";
import type { LoadedNode, ResourceAdapter } from "./types";

/**
 * Collections and projects — the resources that hold other resources.
 */

/**
 * Collections keep their sharing where the SQL tool's row-level security
 * reads it (`collection_grants`, team grantees or the whole organization,
 * `read` or `write`), so the share dialog offers exactly what that layer
 * enforces: teams and the organization, `view` or `edit`. A collection's
 * STRUCTURE — its fields, its sharing, its deletion — stays with the team that
 * owns it (`full` through the team role), never with a grantee.
 *
 * An organization-level collection (`team_id` NULL) belongs to everyone: its
 * records are each team's, so every member edits theirs. Changing the
 * collection itself is an admin's capability (`organization.templates`), not a
 * level anybody holds here.
 */
export const collectionAdapter: ResourceAdapter = {
  type: "collection",
  offeredLevels: ["view", "edit"],
  shareablePrincipals: ["team", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({
        id: collections.id,
        organizationId: collections.organizationId,
        teamId: collections.teamId,
        name: collections.label,
      })
      .from(collections)
      .where(inArray(collections.id, unique));
    const rowIds = rows.map((row) => row.id);

    const [grants, legacy] = await Promise.all([
      loadExplicitGrants("collection", rowIds, executor),
      executor
        .select({
          collectionId: collectionGrants.collectionId,
          organizationId: collectionGrants.organizationId,
          granteeTeamId: collectionGrants.granteeTeamId,
          permission: collectionGrants.permission,
        })
        .from(collectionGrants)
        .where(inArray(collectionGrants.collectionId, rowIds)),
    ]);
    for (const row of legacy) {
      const grant: GrantFact =
        row.granteeTeamId === null
          ? {
              principalType: "organization",
              principalId: row.organizationId,
              level: row.permission === "write" ? "edit" : "view",
            }
          : {
              principalType: "team",
              principalId: row.granteeTeamId,
              level: row.permission === "write" ? "edit" : "view",
            };
      mergeGrants(grants, row.collectionId, [grant]);
    }

    return new Map(
      rows.map((row) => {
        const orgLevel: GrantFact[] =
          row.teamId === null
            ? [
                {
                  principalType: "organization",
                  principalId: row.organizationId,
                  level: "edit",
                },
              ]
            : [];
        const node: LoadedNode = {
          type: "collection",
          id: row.id,
          organizationId: row.organizationId,
          teamId: row.teamId,
          projectId: null,
          ownerUserId: null,
          restricted: false,
          grants: [...(grants.get(row.id) ?? []), ...orgLevel],
          parent: null,
          name: row.name,
        };
        return [row.id, node] as const;
      }),
    );
  },
};

/**
 * A project: a team's container for one subject. Its members are its grants
 * (people, teams); open to its team unless restricted.
 */
export const projectAdapter: ResourceAdapter = {
  type: "project",
  offeredLevels: ["view", "use", "edit", "full"],
  shareablePrincipals: ["user", "team", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({
        id: projects.id,
        organizationId: projects.organizationId,
        teamId: projects.teamId,
        ownerUserId: projects.ownerUserId,
        restricted: projects.accessRestricted,
        name: projects.name,
      })
      .from(projects)
      .where(inArray(projects.id, unique));
    const grants = await loadExplicitGrants(
      "project",
      rows.map((row) => row.id),
      executor,
    );
    return new Map(
      rows.map((row) => {
        const node: LoadedNode = {
          type: "project",
          ...row,
          projectId: null,
          grants: grants.get(row.id) ?? [],
          parent: null,
        };
        return [row.id, node] as const;
      }),
    );
  },
};
