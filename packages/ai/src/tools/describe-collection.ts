import { SYNC_LIMITS } from "@fretik/shared/schemas/collection-sync";
import { describeFieldExpectation } from "@fretik/shared/schemas/record-shape";
import { countRecordsForType } from "@fretik/shared/services/collection-records/count";
import { listSyncSources } from "@fretik/shared/services/collection-sync/list-sources";
import { describeTeamSchema } from "@fretik/shared/services/collections/describe-team-schema";
import { appNameOf } from "@fretik/shared/services/collections/sync-provenance";
import { getFieldDefinitionsForTeam } from "@fretik/shared/services/field-definitions/get-for-team";
import { tool } from "ai";
import { z } from "zod";
import { getRuntimeContext } from "../agents/shared/runtime-context";
import {
  maybePersistLargeOutput,
  SCHEMA_THRESHOLD_CHARS,
} from "../lib/persisted-output";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — full schema of ONE collection: its typed table name,
 * icon/color, every field (key, label, type, description, config incl. select
 * options with their icon/color), and its outgoing relations. Generalizes the
 * old `listFieldDefinitions` (which only knew the document type).
 *
 * Use when `<team_collections>` (key + type only) is not enough: the user-facing
 * label, the `description` (also the LLM extraction hint), the closed list of
 * `select` options, `number` bounds, which fields are filterable, or the current
 * icon/color before editing them.
 */
export const createDescribeCollectionTool = () =>
  tool({
    description: [
      "Full schema of one collection: its `collectionId`, typed table, icon/color, fields (key, label, type, description, config/options), outgoing relations, and — when an app feeds it — every sync source with its cadence, freshness, health and the columns it owns.",
      "",
      "Use this when you need a field's exact `select` options, `number` bounds, `description`, or user-facing label before writing a `querySql` against the type's `data.coll_<collectionId>` table or filtering `listRecords`. It is also where `collectionId` comes from — the uuid a page dataset needs; never reconstruct it from the table name. Get type keys from `<team_collections>`. Also the way to read the full column set of a type that `<team_collections>` shows compacted.",
    ].join("\n"),
    inputSchema: z.object({
      collectionKey: z
        .string()
        .min(1)
        .max(60)
        .describe(
          "Collection slug (e.g. 'company', 'pricing') from <team_collections>.",
        ),
    }),
    execute: async ({ collectionKey }, options) => {
      const ctx = getRuntimeContext(options);
      const { toolCallId } = options;

      let schema: Awaited<ReturnType<typeof describeTeamSchema>>;
      try {
        schema = await describeTeamSchema({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `describeCollection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const type = schema.find((s) => s.key === collectionKey);
      if (!type) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_NOT_FOUND,
          `No collection '${collectionKey}' for this team.`,
          "Check the available type keys in <team_collections>.",
        );
      }

      let fields: Awaited<ReturnType<typeof getFieldDefinitionsForTeam>>;
      try {
        fields = await getFieldDefinitionsForTeam({
          teamId: ctx.teamId,
          collectionId: type.id,
        });
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          `describeCollection failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Volume decides how the type gets READ — enumerate it, aggregate it, or
      // offer an export — and the agent has no other cheap way to know before
      // committing to one. Exact and on demand: `<team_collections>` deliberately
      // carries no count, because a per-turn estimate would be stale precisely
      // after the import that made the type big.
      let recordCount: number | null = null;
      try {
        recordCount = await countRecordsForType({
          collectionId: type.id,
          teamId: ctx.teamId,
        });
      } catch {
        // Non-essential next to the schema — a failed count must not cost the
        // agent the fields it actually asked for.
      }

      // Where the rows come from, when they do not come from this workspace.
      // Read only when something IS synced — `<team_collections>` already said
      // whether anything is, and a collection nobody feeds pays nothing.
      //
      // Every source, not the compacted one: this is the surface `manageSync`
      // acts on, so the agent needs the id it would pass, the cadence it would
      // change, and whether a run is waiting on a confirmation. No note — what
      // `synced` obliges lives in `<collections>`.
      const sources =
        type.syncedFrom === undefined
          ? []
          : await listSyncSources({
              teamId: ctx.teamId,
              collectionId: type.id,
            });
      const fieldsBySource = new Map<string, string[]>();
      for (const field of fields) {
        if (field.syncSourceId === null) continue;
        const list = fieldsBySource.get(field.syncSourceId) ?? [];
        list.push(field.key);
        fieldsBySource.set(field.syncSourceId, list);
      }

      const payload = {
        key: type.key,
        recordCount,
        ...(sources.length === 0
          ? {}
          : {
              sync: {
                sources: sources.map((source) => ({
                  id: source.id,
                  kind: source.kind,
                  // `kind` says whose rows these are; `read` says what one
                  // refresh costs — a call per page, or a call per record.
                  // Neither is derivable from the other, and the second is the
                  // one that decides whether a cadence is affordable.
                  read: source.read,
                  ...(source.matchFieldKey === null
                    ? {}
                    : { matchFieldKey: source.matchFieldKey }),
                  app: appNameOf(
                    source.providerKey,
                    source.connection?.displayName ?? null,
                  ),
                  operation: source.operation,
                  connectionId: source.connectionId,
                  schedule: source.schedule,
                  // The schedule alone understates how fresh this is when the
                  // app pushes: a daily source on an app that notifies is
                  // minutes behind, not a day. Saying "yesterday's figures"
                  // there is wrong in the direction that loses trust.
                  ...(source.notifiesChanges ? { notifiesChanges: true } : {}),
                  incremental: source.incremental,
                  // An incremental source is complete only up to here: a row
                  // deleted upstream survives until the next full walk.
                  fullWalkEveryMinutes: source.incremental
                    ? SYNC_LIMITS.fullWalkIntervalMinutes
                    : null,
                  lastSuccessAt: source.lastSuccessAt,
                  nextRunAt: source.nextRunAt,
                  health: source.health,
                  lastError: source.lastError,
                  orphanPolicy: source.orphanPolicy,
                  ...(source.pendingFullResync === null
                    ? {}
                    : { pendingFullResync: source.pendingFullResync }),
                  fields: fieldsBySource.get(source.id) ?? [],
                })),
              },
            }),
        // The uuid every other tool means by `collectionId`. Given explicitly
        // because it is NOT derivable from the table name: `data.coll_<hex>`
        // drops the dashes, and a page dataset built from that hex silently
        // matches nothing.
        collectionId: type.id,
        label: type.label,
        description: type.description,
        icon: type.icon,
        color: type.color,
        table: type.viewName,
        fields: fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          description: f.description,
          config: f.config,
          isTitle: f.isTitle,
          ...(f.syncSourceId === null ? {} : { synced: true as const }),
          // Exact value encoding for a write (tool or Python SDK) — the shared
          // hint, so e.g. money reads `{ amount, currencyCode }`, not "currency".
          writeFormat: describeFieldExpectation(f),
        })),
        relations: type.relations.map((r) => ({
          key: r.key,
          label: r.label,
          target: r.toCollectionKey ?? "any",
        })),
      };

      return maybePersistLargeOutput(
        payload,
        ctx.conversationId,
        toolCallId,
        SCHEMA_THRESHOLD_CHARS,
      );
    },
  });
