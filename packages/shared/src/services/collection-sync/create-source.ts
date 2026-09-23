import { inArray, sql } from "drizzle-orm";
import db from "../../db";
import type { CollectionSyncSource, FieldDefinition } from "../../db/schema";
import { collectionSyncSources, fieldDefinitions } from "../../db/schema";
import { NON_WRITABLE_FIELD_TYPES } from "../../db/schema/field-types";
import {
  badRequest,
  internalError,
  notFound,
  throwHttpError,
} from "../../lib/errors";
import type {
  CreateSyncSourceInput,
  SyncFieldDraft,
  SyncFieldMapping,
} from "../../schemas/collection-sync";
import { SYNC_LIMITS } from "../../schemas/collection-sync";
import { fieldConfigSchema } from "../../schemas/field-definitions";
import { isMatchableField } from "../collection-schema/find-by-column";
import { RESERVED_FIELD_KEYS } from "../collection-schema/identifiers";
import { noteIndexWanted } from "../collection-schema/reconcile-indexes";
import { invalidateFieldDefinitionsCache } from "../field-definitions/cache";
import { createFieldDefinition } from "../field-definitions/create";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { slugifyFieldKey } from "../field-definitions/slugify-key";
import { assertConnectionUsable } from "./assert-connection-scope";
import { assertSinceBindingForSource } from "./assert-since-binding";
import { requestSyncRefresh } from "./request-refresh";

/**
 * Declare a sync source, and give it the columns it will fill.
 *
 * The columns are created THROUGH `createFieldDefinition`, one call per draft,
 * and that is the one place this service deliberately does not go set-based.
 * Creating a field is not a row insert: it resolves a unique key, decides the
 * collection's title, binds a relation's link type, fills option colours,
 * compiles a formula, emits `field.created`, AND runs the DDL that adds the
 * physical column to `data.coll_<id>` — inserting the rows directly would skip
 * every one of those and leave a catalogue describing a table that does not
 * have the columns. The list is capped at `SYNC_LIMITS.maxMappedFields`, so the
 * loop is bounded by a contract rather than by data.
 *
 * Order matters and is not atomic: fields first (they need to exist to be
 * stamped), then the source row, then one `UPDATE … WHERE id IN (…)` that marks
 * them as belonging to it. A crash between the first and the last leaves
 * ordinary local columns, which is the same state `deleteSyncSource` produces
 * on purpose — the failure mode is a column the user can edit, never a column
 * that lies about where its values come from.
 */

export interface CreateSyncSourceParams extends CreateSyncSourceInput {
  organizationId: string;
  teamId: string;
  userId?: string | null;
}

export const createSyncSource = async (
  params: CreateSyncSourceParams,
): Promise<CollectionSyncSource> => {
  const collection = await db.query.collections.findFirst({
    where: { id: params.collectionId, organizationId: params.organizationId },
    columns: { id: true, teamId: true, semanticIndex: true },
  });
  if (collection === undefined || collection.teamId !== params.teamId) {
    return throwHttpError(404, notFound("Collection not found"));
  }

  // Before anything is created: whose credentials would this run on.
  const providerKey =
    params.connectionId === undefined
      ? params.providerKey
      : (
          await assertConnectionUsable({
            connectionId: params.connectionId,
            teamId: params.teamId,
            userId: params.userId ?? null,
          })
        ).providerKey;

  // Before any column exists: is `{"$since": true}` bound where the action can
  // honour it. Misplaced, it is the one argument whose failure is invisible —
  // the app returns everything and the run still calls itself incremental, so
  // the orphan diff never runs again.
  await assertSinceBindingForSource({
    args: params.args,
    teamId: params.teamId,
    connectionId: params.connectionId ?? null,
    providerKey,
    operation: params.operation,
  });

  if (params.kind === "table") {
    // The unique index would catch this, but "duplicate key value violates
    // constraint" is not an answer to "why can I not sync this collection".
    const existing = await db.query.collectionSyncSources.findFirst({
      where: { collectionId: params.collectionId, kind: "table" },
      columns: { id: true },
    });
    if (existing !== undefined) {
      return throwHttpError(
        400,
        badRequest(
          "This collection is already filled by an app. A collection has one table source: edit that one, or add a lookup source for extra columns.",
        ),
      );
    }
  }

  const existingFields = await getFieldDefinitionsForTeam({
    teamId: params.teamId,
    collectionId: params.collectionId,
    includeDisabled: true,
  });
  const byKey = new Map(existingFields.map((field) => [field.key, field]));

  // Before a single column is created: can this source recognise its rows at
  // all. Checked here rather than at the first run, because a source that
  // cannot match is one that runs green and fills nothing.
  const matchField =
    params.matchFieldKey === undefined
      ? undefined
      : assertMatchField(
          byKey.get(params.matchFieldKey),
          params.matchFieldKey,
          params.fields.map((draft) => draft.fieldKey ?? ""),
        );

  const mapping: SyncFieldMapping[] = [];
  const adoptedFieldIds: string[] = [];
  const createdFieldIds: string[] = [];

  for (const draft of params.fields) {
    const desiredKey = draft.fieldKey ?? slugifyFieldKey(draft.label);
    const existing = byKey.get(desiredKey);

    // A `columns` source fills columns of a collection that already exists, so
    // ADOPTING is the normal case, not the exception — the user picked the
    // columns from a list of the ones already there.
    if (existing !== undefined && params.kind === "columns") {
      assertAdoptable(existing);
      adoptedFieldIds.push(existing.id);
      mapping.push({ path: draft.path, fieldKey: existing.key });
      continue;
    }

    const created = await createFieldDefinition({
      organizationId: params.organizationId,
      teamId: params.teamId,
      collectionId: params.collectionId,
      // The key is passed only when it is FREE. Handing a taken one to the
      // service would fail the `(collectionId, key)` index; omitting it lets
      // `resolveUniqueFieldKey` derive `status_2`, and the mapping then records
      // whatever key came back rather than the one we asked for.
      //
      // A RESERVED key is taken in the same sense and goes the same way. The
      // preview offers the app's `id` as a column and pre-selects it, so the
      // default mapping of almost every action asks for exactly this.
      ...(existing === undefined && !RESERVED_FIELD_KEYS.has(desiredKey)
        ? { key: desiredKey }
        : {}),
      label: draft.label,
      type: draft.type,
      ...(draft.config !== undefined
        ? { config: fieldConfigSchema.parse(draft.config) }
        : {}),
      ...(draft.isTitle !== undefined ? { isTitle: draft.isTitle } : {}),
      // Synced columns are not extraction targets: their value comes from the
      // app, and offering them to the document pre-extract would have a model
      // propose a value the next run overwrites.
      aiExtractionEnabled: false,
      actor: { actorType: "connector" },
    });
    createdFieldIds.push(created.id);
    mapping.push({ path: draft.path, fieldKey: created.key });
    byKey.set(created.key, created);
  }

  const [source] = await db
    .insert(collectionSyncSources)
    .values({
      organizationId: params.organizationId,
      teamId: params.teamId,
      collectionId: params.collectionId,
      kind: params.kind,
      ...(params.connectionId !== undefined
        ? { connectionId: params.connectionId }
        : {}),
      providerKey,
      operation: params.operation,
      args: params.args,
      resultPath: params.resultPath ?? null,
      externalIdPath: params.externalIdPath ?? null,
      matchFieldKey: params.matchFieldKey ?? null,
      fieldMapping: mapping,
      schedule: params.schedule,
      orphanPolicy: params.orphanPolicy,
      rowCap: params.rowCap ?? SYNC_LIMITS.defaultRowCap,
      // Due immediately: the first run is what makes the collection exist as
      // far as the user is concerned, and waiting a cadence for it would read
      // as a broken feature.
      nextRunAt: new Date(),
      createdByUserId: params.userId ?? null,
    })
    .returning();
  if (source === undefined) {
    return throwHttpError(500, internalError());
  }

  const ownedFieldIds = [...createdFieldIds, ...adoptedFieldIds];
  if (ownedFieldIds.length > 0) {
    await db
      .update(fieldDefinitions)
      .set({ syncSourceId: source.id })
      .where(inArray(fieldDefinitions.id, ownedFieldIds));
    await invalidateFieldDefinitionsCache({
      organizationId: params.organizationId,
      teamId: params.teamId,
    });
  }

  // The match column is read on every page of every walk, so the index that
  // serves it must not be pruned away under a source that runs once a day.
  // Reviving costs a statement only when one was actually dropped.
  if (matchField !== undefined) {
    noteIndexWanted({ fields: existingFields, keys: [matchField.key] });
  }

  // A synced collection is usually a working table — orders, invoices, stock
  // movements — and embedding every row of one is recall noise that crowds
  // out what a person actually wrote. Only when nothing has been chosen
  // yet (`NULL` = "decide from the row count"), so an explicit `true` from a
  // user stands.
  if (params.kind === "table" && collection.semanticIndex === null) {
    await db.execute(sql`
      UPDATE collections SET semantic_index = false
       WHERE id = ${params.collectionId}::uuid AND semantic_index IS NULL`);
  }

  await requestSyncRefresh({
    sourceId: source.id,
    teamId: params.teamId,
    trigger: "initial",
    ...(params.userId != null ? { userId: params.userId } : {}),
  });

  return source;
};

/**
 * Whether an existing column may be handed to a source.
 *
 * Two refusals, both about ownership. A field another source already fills
 * would have two apps writing one column and no answer to "which one is right".
 * A DERIVED field — formula, rollup, relation, `unique_id`, the system
 * properties — cannot be filled at all: a formula is a `GENERATED … STORED`
 * column Postgres physically refuses a value for, and a relation lives in the
 * `links` graph. Accepting either would produce a source whose every run
 * reports rows it never wrote.
 */
export const assertAdoptable = (
  field: Pick<FieldDefinition, "key" | "type" | "syncSourceId">,
): void => {
  if (field.syncSourceId !== null) {
    return throwHttpError(
      400,
      badRequest(
        `The column "${field.key}" is already filled by another app. Remove it from that source first, or map this value to a new column.`,
      ),
    );
  }
  if (NON_WRITABLE_FIELD_TYPES.has(field.type)) {
    return throwHttpError(
      400,
      badRequest(
        `The column "${field.key}" is a ${field.type}: its value is computed from other data, so an app cannot fill it. Map the value to a plain column and let the ${field.type} read that.`,
      ),
    );
  }
};

/**
 * The column a walked `columns` source recognises its rows by.
 *
 * Three refusals, each because the failure it prevents is silent. A column
 * that does not exist, or has been disabled, matches nothing — the source runs
 * green and fills no column. A type with no single comparable value (`money`
 * is two columns, `multi_select` an array, `location` a foreign key) cannot be
 * equated at all. And a column this same source WRITES would move the target
 * between runs: the app's own value would overwrite the key that found it, and
 * the next walk would land on a different record, or none.
 */
export const assertMatchField = (
  field: FieldDefinition | undefined,
  key: string,
  mappedKeys: readonly string[],
): FieldDefinition => {
  if (field === undefined) {
    return throwHttpError(
      400,
      badRequest(
        `There is no column "${key}" on this collection to match rows on. Pick one of its existing columns, or add it first.`,
      ),
    );
  }
  if (!isMatchableField(field)) {
    return throwHttpError(
      400,
      badRequest(
        `The column "${key}" cannot identify a row: a ${field.type}${field.enabled ? "" : " that is turned off"} has no single value to compare. Match on a code, a reference, an email or a number.`,
      ),
    );
  }
  if (mappedKeys.includes(key)) {
    return throwHttpError(
      400,
      badRequest(
        `"${key}" is how rows are matched, so this source cannot also fill it: the app's own value would overwrite the key that found the row. Map a different column.`,
      ),
    );
  }
  return field;
};

/** Shared by create and update: the draft list a source may carry. */
export const assertDraftLimit = (drafts: readonly SyncFieldDraft[]): void => {
  if (drafts.length > SYNC_LIMITS.maxMappedFields) {
    return throwHttpError(
      400,
      badRequest(
        `A source fills at most ${String(SYNC_LIMITS.maxMappedFields)} columns.`,
      ),
    );
  }
};
