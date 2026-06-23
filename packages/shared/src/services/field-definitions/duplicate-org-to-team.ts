import { and, eq, isNull } from "drizzle-orm";
import db from "../../db";
import type { NewFieldDefinition } from "../../db/schema";
import { fieldDefinitions } from "../../db/schema";
import { syncAllTypedViewsForTeam } from "../object-types/sync-typed-view";
import { invalidateTeamFieldDefinitionsCache } from "./cache";

/**
 * Copy every organization-scope field definition into a freshly created
 * team. Called from the team-creation hook (Better Auth) so the team
 * starts with a complete snapshot of its org's template.
 *
 * One-shot: future edits to the org-scope definitions never propagate.
 * The team owns its definitions from this point on.
 *
 * Cache invalidation : drop the team's field-definitions sub-tree after
 * the transaction commits so the very next read picks up the seed.
 */
export const duplicateOrgDefsToTeam = async (data: {
  organizationId: string;
  teamId: string;
}): Promise<{ inserted: number }> => {
  const { organizationId, teamId } = data;

  const result = await db.transaction(async (tx) => {
    const orgDefs = await tx
      .select()
      .from(fieldDefinitions)
      .where(
        and(
          eq(fieldDefinitions.organizationId, organizationId),
          isNull(fieldDefinitions.teamId),
        ),
      );

    let inserted = 0;
    if (orgDefs.length > 0) {
      const rows: NewFieldDefinition[] = orgDefs.map((def) => ({
        organizationId,
        teamId,
        objectTypeId: def.objectTypeId,
        key: def.key,
        label: def.label,
        description: def.description,
        type: def.type,
        config: def.config,
        isTitle: def.isTitle,
        aiExtractionEnabled: def.aiExtractionEnabled,
        vectorizeInclude: def.vectorizeInclude,
        displayInPanel: def.displayInPanel,
        displayInFilters: def.displayInFilters,
        enabled: def.enabled,
        displayOrder: def.displayOrder,
      }));

      const insertedRows = await tx
        .insert(fieldDefinitions)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: fieldDefinitions.id });
      inserted = insertedRows.length;
    }

    // Build the team's typed views now that its field defs exist — one per
    // visible type (its own + org/system). Atomic with the copy and cheap (a
    // new team has no records). Runs even when 0 defs were copied so the system
    // types still get structural-only views.
    await syncAllTypedViewsForTeam({ tx, organizationId, teamId });

    return { inserted };
  });

  await invalidateTeamFieldDefinitionsCache(teamId);
  return result;
};
