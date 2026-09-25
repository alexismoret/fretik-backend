import { inArray, sql } from "drizzle-orm";
import db from "../../db";
import { pages, workflows } from "../../db/schema";
import { loadExplicitGrants } from "./grants";
import type { LoadedNode, ResourceAdapter } from "./types";

/**
 * Pages and workflows: flat resources held by a team (or a project in it).
 *
 * Both still carry the LEGACY privacy column `user_id` — "private to this
 * person" — which the code before the engine reads and an older container may
 * still write during a deploy. So a row is restricted when EITHER column says
 * so, and its owner falls back to `user_id`, then to its author. The write
 * side keeps `user_id = access_restricted ? owner_user_id : null`, which makes
 * the two readings agree on every row this code writes.
 */

export const pageAdapter: ResourceAdapter = {
  type: "page",
  offeredLevels: ["view", "use", "edit", "full"],
  shareablePrincipals: ["user", "team", "project", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({
        id: pages.id,
        organizationId: pages.organizationId,
        teamId: pages.teamId,
        projectId: pages.projectId,
        ownerUserId: sql<
          string | null
        >`COALESCE(${pages.ownerUserId}, ${pages.userId}, ${pages.createdByUserId})`,
        restricted: sql<boolean>`(${pages.accessRestricted} OR ${pages.userId} IS NOT NULL)`,
        name: pages.name,
      })
      .from(pages)
      .where(inArray(pages.id, unique));
    const grants = await loadExplicitGrants(
      "page",
      rows.map((row) => row.id),
      executor,
    );
    return new Map(
      rows.map((row) => {
        const node: LoadedNode = {
          type: "page",
          ...row,
          grants: grants.get(row.id) ?? [],
          parent: null,
        };
        return [row.id, node] as const;
      }),
    );
  },
};

export const workflowAdapter: ResourceAdapter = {
  type: "workflow",
  offeredLevels: ["view", "use", "edit", "full"],
  shareablePrincipals: ["user", "team", "project", "organization"],
  loadNodes: async (ids, executor = db) => {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({
        id: workflows.id,
        organizationId: workflows.organizationId,
        teamId: workflows.teamId,
        projectId: workflows.projectId,
        ownerUserId: sql<
          string | null
        >`COALESCE(${workflows.ownerUserId}, ${workflows.userId}, ${workflows.createdByUserId})`,
        restricted: sql<boolean>`(${workflows.accessRestricted} OR ${workflows.userId} IS NOT NULL)`,
        name: workflows.name,
      })
      .from(workflows)
      .where(inArray(workflows.id, unique));
    const grants = await loadExplicitGrants(
      "workflow",
      rows.map((row) => row.id),
      executor,
    );
    return new Map(
      rows.map((row) => {
        const node: LoadedNode = {
          type: "workflow",
          ...row,
          grants: grants.get(row.id) ?? [],
          parent: null,
        };
        return [row.id, node] as const;
      }),
    );
  },
};
