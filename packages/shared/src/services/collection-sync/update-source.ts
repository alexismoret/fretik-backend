import { and, eq, inArray, notInArray } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncSource } from "../../db/schema";
import { collectionSyncSources, fieldDefinitions } from "../../db/schema";
import { internalError, notFound, throwHttpError } from "../../lib/errors";
import type {
  SyncFieldMapping,
  UpdateSyncSourceInput,
} from "../../schemas/collection-sync";
import { fieldConfigSchema } from "../../schemas/field-definitions";
import { invalidateFieldDefinitionsCache } from "../field-definitions/cache";
import { createFieldDefinition } from "../field-definitions/create";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { slugifyFieldKey } from "../field-definitions/slugify-key";
import { assertConnectionUsable } from "./assert-connection-scope";
import { assertAdoptable, assertDraftLimit } from "./create-source";
import { computeNextRunAt } from "./sweep";

/**
 * Edit a source: what it asks for, how often, what it does with orphans, and
 * which columns it fills.
 *
 * What an edit may NOT change is decided by the wire schema and worth
 * restating, because the refusals are the design: not the kind, not the
 * collection, not the external-id path. Those three decide what a RECORD IS,
 * and changing one under 20 000 stored rows would silently re-key every one of
 * them — the second run would then create 20 000 duplicates and orphan the
 * originals. Rebuilding is a delete and a create, which at least says out loud
 * what happens to the data.
 *
 * Adding and dropping mapped columns IS allowed, and a dropped column is
 * RELEASED, never deleted: it keeps its values and becomes editable, exactly as
 * `deleteSyncSource` leaves the whole set. Nothing a user can do from this
 * screen destroys a column.
 */
export const updateSyncSource = async (params: {
  id: string;
  teamId: string;
  organizationId: string;
  /** The person acting — a move to a personal connection is theirs to make. */
  userId?: string | null;
  patch: UpdateSyncSourceInput;
}): Promise<CollectionSyncSource> => {
  const source = await db.query.collectionSyncSources.findFirst({
    where: { id: params.id, teamId: params.teamId },
  });
  if (source === undefined) {
    return throwHttpError(404, notFound("Sync source not found"));
  }
  const { patch } = params;

  // Re-pointing a source at another connection is the same decision as
  // building it on one, so it meets the same bar.
  if (patch.connectionId != null) {
    await assertConnectionUsable({
      connectionId: patch.connectionId,
      teamId: params.teamId,
      userId: params.userId ?? null,
    });
  }

  let mapping: SyncFieldMapping[] | undefined;
  let fieldsChanged = false;
  if (patch.fields !== undefined) {
    assertDraftLimit(patch.fields);
    const existingFields = await getFieldDefinitionsForTeam({
      teamId: params.teamId,
      collectionId: source.collectionId,
      includeDisabled: true,
    });
    const byKey = new Map(existingFields.map((field) => [field.key, field]));
    const keptFieldIds: string[] = [];
    mapping = [];

    for (const draft of patch.fields) {
      const desiredKey = draft.fieldKey ?? slugifyFieldKey(draft.label);
      const existing = byKey.get(desiredKey);
      if (existing !== undefined) {
        // Already ours: nothing to do but keep it. Otherwise the same two
        // refusals as on create — another source's column, or a derived one.
        if (existing.syncSourceId !== source.id) assertAdoptable(existing);
        keptFieldIds.push(existing.id);
        mapping.push({ path: draft.path, fieldKey: existing.key });
        continue;
      }
      const created = await createFieldDefinition({
        organizationId: params.organizationId,
        teamId: params.teamId,
        collectionId: source.collectionId,
        key: desiredKey,
        label: draft.label,
        type: draft.type,
        ...(draft.config !== undefined
          ? { config: fieldConfigSchema.parse(draft.config) }
          : {}),
        aiExtractionEnabled: false,
        actor: { actorType: "connector" },
      });
      keptFieldIds.push(created.id);
      mapping.push({ path: draft.path, fieldKey: created.key });
    }

    // Release everything this source owned and no longer maps. One statement,
    // and `notInArray` with an empty list is not valid SQL — an edit that drops
    // every column releases them all.
    await db
      .update(fieldDefinitions)
      .set({ syncSourceId: null })
      .where(
        keptFieldIds.length === 0
          ? eq(fieldDefinitions.syncSourceId, source.id)
          : and(
              eq(fieldDefinitions.syncSourceId, source.id),
              notInArray(fieldDefinitions.id, keptFieldIds),
            ),
      );
    if (keptFieldIds.length > 0) {
      await db
        .update(fieldDefinitions)
        .set({ syncSourceId: source.id })
        .where(inArray(fieldDefinitions.id, keptFieldIds));
    }
    fieldsChanged = true;
  }

  const schedule = patch.schedule ?? source.schedule;
  const enabled = patch.enabled ?? source.enabled;
  // Re-slot on every edit that can move the cadence. A source turned back on,
  // or moved from daily to hourly, must not wait out the OLD interval before
  // anyone sees the difference — and a re-enabled source starts from zero
  // failures, because "I fixed it" is what pressing the switch means.
  const failures = patch.enabled === true ? 0 : source.consecutiveFailures;
  const scheduleTouched =
    patch.schedule !== undefined || patch.enabled !== undefined;
  const nextRunAt = !enabled
    ? null
    : scheduleTouched
      ? computeNextRunAt({ schedule, consecutiveFailures: failures })
      : source.nextRunAt;

  const [updated] = await db
    .update(collectionSyncSources)
    .set({
      ...(patch.connectionId !== undefined
        ? { connectionId: patch.connectionId }
        : {}),
      ...(patch.args !== undefined ? { args: patch.args } : {}),
      ...(patch.resultPath !== undefined
        ? { resultPath: patch.resultPath }
        : {}),
      ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
      ...(patch.orphanPolicy !== undefined
        ? { orphanPolicy: patch.orphanPolicy }
        : {}),
      ...(patch.rowCap !== undefined ? { rowCap: patch.rowCap } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(mapping !== undefined ? { fieldMapping: mapping } : {}),
      consecutiveFailures: failures,
      nextRunAt,
    })
    .where(eq(collectionSyncSources.id, source.id))
    .returning();
  if (updated === undefined) return throwHttpError(500, internalError());

  if (fieldsChanged) {
    await invalidateFieldDefinitionsCache({
      organizationId: params.organizationId,
      teamId: params.teamId,
    });
  }
  return updated;
};
