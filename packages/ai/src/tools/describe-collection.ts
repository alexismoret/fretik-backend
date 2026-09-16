import { describeFieldExpectation } from "@fretik/shared/schemas/record-shape";
import { countRecordsForType } from "@fretik/shared/services/collection-records/count";
import { describeTeamSchema } from "@fretik/shared/services/collections/describe-team-schema";
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
      "Full schema of one collection: its `collectionId`, typed table, icon/color, fields (key, label, type, description, config/options), and outgoing relations.",
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
      // The agent reads two things here it can act on: the columns it must not
      // write, and the AGE of every figure it is about to quote.
      const syncedFrom = type.syncedFrom;

      const payload = {
        key: type.key,
        recordCount,
        ...(syncedFrom === undefined
          ? {}
          : {
              syncedFrom: {
                app: syncedFrom.app,
                operation: syncedFrom.operation,
                lastSuccessAt: syncedFrom.lastSuccessAt?.toISOString() ?? null,
                note: "Columns marked `synced` are filled by this app and refuse any write. `manageCollection` action refreshSync re-pulls them.",
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
