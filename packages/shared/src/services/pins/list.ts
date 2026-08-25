import { and, eq, inArray } from "drizzle-orm";
import db from "../../db";
import { userPins } from "../../db/schema";
import type { PinItem } from "../../schemas/pins";
import { listCollections } from "../collections/retrieve";
import { pageVisibilityWhere, type PageRequester } from "../pages/visibility";
import { workflowVisibilityWhere } from "../workflows/visibility";

/**
 * Render one user's sidebar pins, in their chosen order.
 *
 * Two lookups that LOOK redundant are not, and collapsing them would be a bug:
 *
 *  - the EXISTENCE check is unscoped (`WHERE id IN (…)` on the target tables).
 *    A row whose target is absent from its table is a TRUE orphan — the target
 *    was deleted through a path that did not reach `deletePinsForTarget` (an FK
 *    cascade, a manual DELETE) — and is reaped here, once, awaited.
 *  - the VISIBILITY check is scoped to the caller (`listCollections` for its
 *    cross-team grant logic, the page and workflow visibility predicates for
 *    private pages and private workflows). A row that exists but is not
 *    currently visible or enabled is simply left OUT of the response and KEPT
 *    in the table: a disabled collection that gets re-enabled must bring its
 *    pin back, and a pin must never become a probe for a page or a workflow
 *    the caller may not see.
 */
export const listUserPins = async (params: {
  userId: string;
  organizationId: string;
  teamId: string;
  requester?: PageRequester;
}): Promise<PinItem[]> => {
  const rows = await db.query.userPins.findMany({
    where: {
      userId: params.userId,
      organizationId: params.organizationId,
      teamId: params.teamId,
    },
    orderBy: { displayOrder: "asc", createdAt: "asc" },
  });
  if (rows.length === 0) return [];

  const collectionIds = rows
    .filter((row) => row.targetType === "collection")
    .map((row) => row.targetId);
  const pageIds = rows
    .filter((row) => row.targetType === "page")
    .map((row) => row.targetId);
  const workflowIds = rows
    .filter((row) => row.targetType === "workflow")
    .map((row) => row.targetId);

  // ---- Existence (unscoped): anything missing here is a true orphan --------

  const existingCollections =
    collectionIds.length > 0
      ? await db.query.collections.findMany({
          columns: { id: true },
          where: { id: { in: collectionIds } },
        })
      : [];
  const existingPages =
    pageIds.length > 0
      ? await db.query.pages.findMany({
          columns: { id: true },
          where: { id: { in: pageIds } },
        })
      : [];
  const existingWorkflows =
    workflowIds.length > 0
      ? await db.query.workflows.findMany({
          columns: { id: true },
          where: { id: { in: workflowIds } },
        })
      : [];
  const existingIds = new Set([
    ...existingCollections.map((row) => row.id),
    ...existingPages.map((row) => row.id),
    ...existingWorkflows.map((row) => row.id),
  ]);

  const orphanIds = rows
    .map((row) => row.targetId)
    .filter((targetId) => !existingIds.has(targetId));
  if (orphanIds.length > 0) {
    await db
      .delete(userPins)
      .where(
        and(
          eq(userPins.userId, params.userId),
          eq(userPins.teamId, params.teamId),
          inArray(userPins.targetId, orphanIds),
        ),
      );
  }

  // ---- Visibility (scoped): what this caller may actually navigate to ------

  const visibleCollections =
    collectionIds.length > 0
      ? await listCollections({
          organizationId: params.organizationId,
          teamId: params.teamId,
          includeDisabled: false,
        })
      : [];
  const collectionById = new Map(
    visibleCollections.map((collection) => [collection.id, collection]),
  );

  const visiblePages =
    pageIds.length > 0
      ? await db.query.pages.findMany({
          columns: { id: true, name: true, icon: true, color: true },
          where: {
            id: { in: pageIds },
            teamId: params.teamId,
            ...pageVisibilityWhere(params.requester),
          },
        })
      : [];
  const pageById = new Map(visiblePages.map((page) => [page.id, page]));

  const visibleWorkflows =
    workflowIds.length > 0
      ? await db.query.workflows.findMany({
          columns: { id: true, name: true, icon: true, color: true },
          where: {
            id: { in: workflowIds },
            teamId: params.teamId,
            ...workflowVisibilityWhere(params.requester),
          },
        })
      : [];
  const workflowById = new Map(
    visibleWorkflows.map((workflow) => [workflow.id, workflow]),
  );

  const items: PinItem[] = [];
  for (const row of rows) {
    if (row.targetType === "collection") {
      const collection = collectionById.get(row.targetId);
      if (!collection) continue;
      items.push({
        targetType: row.targetType,
        targetId: row.targetId,
        key: collection.key,
        // The plural, like every other list surface: a nav entry points at the
        // records, not at one of them.
        label: collection.labelPlural ?? collection.label,
        icon: collection.icon,
        color: collection.color,
        displayOrder: row.displayOrder,
        pinnedAt: row.createdAt,
      });
      continue;
    }
    if (row.targetType === "workflow") {
      const workflow = workflowById.get(row.targetId);
      if (!workflow) continue;
      items.push({
        targetType: row.targetType,
        targetId: row.targetId,
        // A workflow is addressed by id, so it carries no route key.
        key: null,
        label: workflow.name,
        icon: workflow.icon,
        color: workflow.color,
        displayOrder: row.displayOrder,
        pinnedAt: row.createdAt,
      });
      continue;
    }
    const page = pageById.get(row.targetId);
    if (!page) continue;
    items.push({
      targetType: row.targetType,
      targetId: row.targetId,
      // A page is addressed by id, so it carries no route key.
      key: null,
      label: page.name,
      icon: page.icon,
      color: page.color,
      displayOrder: row.displayOrder,
      pinnedAt: row.createdAt,
    });
  }
  return items;
};
