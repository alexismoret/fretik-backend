import {
  SYNC_LIMITS,
  syncArgsSchema,
  syncOrphanPolicySchema,
  syncScheduleSchema,
} from "@fretik/shared/schemas/collection-sync";
import { fieldDefinitionTypeSchema } from "@fretik/shared/schemas/field-definitions";
import { SYNC_LOCKED_IN_WORKFLOW } from "@fretik/shared/services/ai/remediation";
import { confirmFullResync } from "@fretik/shared/services/collection-sync/confirm-full-resync";
import { createSyncSource } from "@fretik/shared/services/collection-sync/create-source";
import { deleteSyncSource } from "@fretik/shared/services/collection-sync/delete-source";
import { estimateSyncCostForConnection } from "@fretik/shared/services/collection-sync/estimate-cost";
import { listSyncSources } from "@fretik/shared/services/collection-sync/list-sources";
import { previewSyncSource } from "@fretik/shared/services/collection-sync/preview";
import { requestSyncRefresh } from "@fretik/shared/services/collection-sync/request-refresh";
import { updateSyncSource } from "@fretik/shared/services/collection-sync/update-source";
import { createCollection } from "@fretik/shared/services/collections/create";
import { resolveCollectionId } from "@fretik/shared/services/collections/resolve";
import { appNameOf } from "@fretik/shared/services/collections/sync-provenance";
import { tool } from "ai";
import { z } from "zod";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * Domain tool (deferred) — the collections an APP fills, not the ones the team
 * types by hand.
 *
 * Why its own tool rather than an action on `manageCollection`: declaring a
 * source is a mapping decision (which app, which action, which arguments,
 * which upstream path becomes which column, how often, what happens to a row
 * that disappears upstream) and every one of those is made against a live
 * preview of the app's real answer. Folding that into the schema tool would
 * mean a create that guessed, and a guessed mapping produces a collection
 * nobody can read.
 *
 * `preview` before `create` is a contract, not a suggestion: the preview is
 * where the stable id, the field types and the pagination promise come from,
 * and none of the three can be inferred from an action's name.
 */

const PREVIEW_FIRST =
  "Run `preview` first — it returns the rows, the proposed columns and the candidate stable id that `create` needs.";

const fieldDraftSchema = z.object({
  path: z
    .string()
    .describe(
      "Dotted path into one upstream row, from the preview's `fields`.",
    ),
  label: z.string().optional().describe("Column label. Defaults to the path."),
  key: z
    .string()
    .max(60)
    .optional()
    .describe("snake_case column key. Defaults to a slug of the label."),
  type: fieldDefinitionTypeSchema
    .optional()
    .describe("Defaults to the type the preview inferred for this path."),
  isTitle: z
    .boolean()
    .optional()
    .describe("The column that names a record. One per table source."),
});

/** One source, as the agent needs to read it back. */
const briefOf = (source: {
  id: string;
  kind: string;
  providerKey: string;
  connection: { displayName: string } | null;
  operation: string;
  schedule: unknown;
  incremental: boolean;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  health: string;
  lastError: string | null;
  orphanPolicy: string;
  pendingFullResync: { requestedAt: string; reason: string } | null;
}): Record<string, unknown> => ({
  id: source.id,
  kind: source.kind,
  app: appNameOf(source.providerKey, source.connection?.displayName ?? null),
  operation: source.operation,
  schedule: source.schedule,
  incremental: source.incremental,
  lastSuccessAt: source.lastSuccessAt,
  nextRunAt: source.nextRunAt,
  health: source.health,
  orphanPolicy: source.orphanPolicy,
  ...(source.lastError === null ? {} : { lastError: source.lastError }),
  ...(source.pendingFullResync === null
    ? {}
    : { pendingFullResync: source.pendingFullResync }),
});

export const createManageSyncTool = () =>
  tool({
    description: [
      "Fill a collection — or some of its columns — from a connected app, on a schedule. This is how a table whose data lives in another system gets into the workspace: declared once, refreshed by itself, queryable like any other collection.",
      "",
      "Two shapes. A `table` source OWNS a collection's rows: it walks a list action and each upstream row becomes a record, keyed by a stable upstream id. A `lookup` source fills COLUMNS of records that already exist: each record's own values bind the arguments, and the answer lands in the mapped columns.",
      "",
      `Actions: preview | create | update | delete | refresh | confirmFullResync | list. ${PREVIEW_FIRST}`,
      "",
      "- preview: connectionId + operation (+ args). Returns up to 20 real rows, a proposed column for each path, the candidate stable ids, whether the action can be walked to the end, and what the chosen cadence would cost against the app's published budget. Costs one call to the app.",
      "- create: collectionKey for an existing collection, OR key + label + description + icon to make a new one. Plus connectionId, operation, args, fields, externalIdPath (table), schedule, orphanPolicy. The first run starts in the background.",
      "- update: sourceId + any of args, schedule, orphanPolicy, rowCap, enabled, fields.",
      "- delete: sourceId. The columns stay and become ordinary local ones — the records are NOT deleted.",
      "- refresh: sourceId (or collectionKey for all of a collection's). Queues a run and returns immediately; re-read the rows afterwards, not in the same breath.",
      "- confirmFullResync: sourceId. A run that would have orphaned most of a collection refuses and asks. Only confirm what the user confirmed.",
      "- list: collectionKey, or nothing for every source of the team.",
      "",
      'Read `skills/designing-collections/SKILL.md` before creating one — it carries the mapping rules (stable ids, `{"$field"}` bindings, cadence, what to tell the user afterwards).',
      "",
      "A source runs on a connection's credentials, so a personal connection can only be used by its owner — the refusal names it. To read an app ONCE, call its read action instead; this tool is for data the team wants to keep.",
    ].join("\n"),
    inputSchema: z.object({
      action: z.enum([
        "preview",
        "create",
        "update",
        "delete",
        "refresh",
        "confirmFullResync",
        "list",
      ]),
      sourceId: z
        .string()
        .optional()
        .describe("Required for update / delete / confirmFullResync."),
      collectionKey: z
        .string()
        .max(60)
        .optional()
        .describe(
          "Existing collection to fill. On create, omit it and pass key + label + description + icon to make a new one.",
        ),
      key: z
        .string()
        .max(60)
        .optional()
        .describe("snake_case slug for a NEW collection (create only)."),
      label: z.string().optional(),
      description: z
        .string()
        .optional()
        .describe("What this collection is for, one line."),
      icon: z.string().optional(),
      kind: z
        .enum(["table", "lookup"])
        .optional()
        .describe("Defaults to table."),
      connectionId: z.string().optional(),
      operation: z
        .string()
        .optional()
        .describe("The app's read action, e.g. `list_orders`."),
      // Flat on purpose. The real argument type is recursive (a binding can
      // sit at any depth), and a recursive Zod schema converts to JSON Schema
      // with `$defs` + `$ref` — which at least one upstream refuses outright
      // (see `tool-schema-hygiene.test.ts`). It is parsed against the real
      // schema inside `execute`, so nothing is validated less; the difference
      // is only which side of the wire the shape is checked on.
      args: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'Literals, plus two bindings: {"$field": "<column key>"} takes the value from the record being filled (lookup), {"$since": true} asks the app for what changed since the last run.',
        ),
      resultPath: z
        .string()
        .optional()
        .describe("Dotted path to the array of rows, when it is nested."),
      externalIdPath: z
        .string()
        .optional()
        .describe(
          "The upstream row's own stable id. Required for a table source — without it every run duplicates the collection instead of updating it.",
        ),
      fields: z.array(fieldDraftSchema).optional(),
      schedule: syncScheduleSchema
        .optional()
        .describe("{ mode: 'manual' } or { mode: 'interval', everyMinutes }."),
      orphanPolicy: syncOrphanPolicySchema
        .optional()
        .describe(
          "What happens to a record the app stops returning: keep (default), reject, or delete.",
        ),
      rowCap: z.number().int().optional(),
      sampleRecordId: z
        .string()
        .optional()
        .describe("Preview a lookup against this record's values."),
    }),
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const userId = ctx.userId ?? null;

      // The same door the Python `collections.sync.*` ops hold: a run refreshes
      // and reads, never declares. Held here rather than in the prompt alone —
      // the prompt said it, and this tool let it through.
      if (
        ctx.workflowRunId !== undefined &&
        input.action !== "refresh" &&
        input.action !== "list" &&
        input.action !== "preview"
      ) {
        return toolError(TOOL_ERROR_CODES.FORBIDDEN, SYNC_LOCKED_IN_WORKFLOW);
      }

      // The real argument shape, checked here rather than in the tool schema —
      // see the `args` note above.
      const parsedArgs = syncArgsSchema.safeParse(input.args ?? {});
      if (!parsedArgs.success) {
        return toolError(
          TOOL_ERROR_CODES.INVALID_ARGS,
          `args: ${parsedArgs.error.issues[0]?.message ?? "not a valid argument map"}`,
          'Arguments are literals, {"$field": "<column key>"} or {"$since": true} — nothing else.',
        );
      }
      const args = parsedArgs.data;

      const collectionIdOf = async (): Promise<string | null> =>
        input.collectionKey === undefined
          ? null
          : await resolveCollectionId({
              teamId: ctx.teamId,
              organizationId: ctx.organizationId,
              key: input.collectionKey,
            });

      try {
        if (input.action === "list") {
          const collectionId = await collectionIdOf();
          const sources = await listSyncSources({
            teamId: ctx.teamId,
            ...(collectionId === null ? {} : { collectionId }),
          });
          return { ok: true, sources: sources.map(briefOf) };
        }

        if (input.action === "preview") {
          if (
            input.connectionId === undefined ||
            input.operation === undefined
          ) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "preview needs connectionId and operation.",
              "List the team's connections, then pass the app's read action name.",
            );
          }
          const preview = await previewSyncSource({
            teamId: ctx.teamId,
            userId,
            connectionId: input.connectionId,
            operation: input.operation,
            args,
            ...(input.resultPath === undefined
              ? {}
              : { resultPath: input.resultPath }),
            ...(input.sampleRecordId === undefined
              ? {}
              : { sampleRecordId: input.sampleRecordId }),
          });
          return {
            ok: true,
            rows: preview.rows,
            fields: preview.fields,
            suggestedIdPaths: preview.suggestedIdPaths,
            pagination: preview.pagination,
            ...(preview.batch === undefined ? {} : { batch: preview.batch }),
            ...(preview.warning === undefined
              ? {}
              : { warning: preview.warning }),
            // The kind decides the whole cost model — one call per page against
            // one call per record — so it is passed even though `create`
            // defaults it, and a preview asked without one is priced as the
            // `table` it will become.
            cost: await estimateSyncCostForConnection({
              teamId: ctx.teamId,
              connectionId: input.connectionId,
              kind: input.kind ?? "table",
              schedule: input.schedule ?? { mode: "manual" },
              ...(input.kind === "lookup"
                ? {}
                : { rowCap: input.rowCap ?? SYNC_LIMITS.maxRowCap }),
              pageSize: preview.pagination?.maxLimit,
              ...(preview.batch === undefined
                ? {}
                : { batchMaxItems: preview.batch.maxItems }),
            }),
          };
        }

        if (input.action === "refresh") {
          const collectionId = await collectionIdOf();
          const sources =
            input.sourceId !== undefined
              ? (await listSyncSources({ teamId: ctx.teamId })).filter(
                  (source) => source.id === input.sourceId,
                )
              : await listSyncSources({
                  teamId: ctx.teamId,
                  ...(collectionId === null ? {} : { collectionId }),
                });
          const runnable = sources.filter((source) => source.enabled);
          if (runnable.length === 0) {
            return toolError(
              TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
              "Nothing to refresh here.",
              sources.length > 0
                ? "The source is turned off — a person re-enables it in the collection's sync settings."
                : "This collection's columns are filled by the workspace, not by an app.",
            );
          }
          const queued = await Promise.all(
            runnable.map(async (source) => ({
              id: source.id,
              app: appNameOf(
                source.providerKey,
                source.connection?.displayName ?? null,
              ),
              operation: source.operation,
              ...(await requestSyncRefresh({
                sourceId: source.id,
                teamId: ctx.teamId,
                trigger: "manual",
                ...(userId === null ? {} : { userId }),
              })),
            })),
          );
          return {
            ok: true,
            queued,
            note: "Runs land in the background. Re-read the records before quoting figures from them.",
          };
        }

        if (input.action === "confirmFullResync") {
          if (input.sourceId === undefined) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "confirmFullResync needs sourceId.",
            );
          }
          await confirmFullResync({
            sourceId: input.sourceId,
            teamId: ctx.teamId,
            ...(userId === null ? {} : { userId }),
          });
          return {
            ok: true,
            note: "The next run will apply the orphan policy it refused. It runs in the background.",
          };
        }

        if (input.action === "delete") {
          if (input.sourceId === undefined) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "delete needs sourceId.",
            );
          }
          await deleteSyncSource({
            id: input.sourceId,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
          });
          return {
            ok: true,
            note: "The columns it filled are now ordinary local ones. No record was deleted.",
          };
        }

        if (input.action === "update") {
          if (input.sourceId === undefined) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "update needs sourceId.",
            );
          }
          const source = await updateSyncSource({
            id: input.sourceId,
            teamId: ctx.teamId,
            organizationId: ctx.organizationId,
            userId,
            patch: {
              ...(input.args === undefined ? {} : { args }),
              ...(input.schedule === undefined
                ? {}
                : { schedule: input.schedule }),
              ...(input.orphanPolicy === undefined
                ? {}
                : { orphanPolicy: input.orphanPolicy }),
              ...(input.rowCap === undefined ? {} : { rowCap: input.rowCap }),
              ...(input.fields === undefined
                ? {}
                : { fields: input.fields.map(toDraft) }),
            },
          });
          return { ok: true, sourceId: source.id };
        }

        // create
        if (
          input.connectionId === undefined ||
          input.operation === undefined ||
          input.fields === undefined ||
          input.fields.length === 0
        ) {
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            "create needs connectionId, operation and at least one mapped field.",
            PREVIEW_FIRST,
          );
        }
        const kind = input.kind ?? "table";
        if (kind === "table" && input.externalIdPath === undefined) {
          return toolError(
            TOOL_ERROR_CODES.INVALID_ARGS,
            "A table source needs externalIdPath — the upstream row's own stable id.",
            "The preview's `suggestedIdPaths` ranks the candidates; pick the one that will not change between runs.",
          );
        }

        let collectionId = await collectionIdOf();
        if (collectionId === null) {
          if (
            input.key === undefined ||
            input.label === undefined ||
            input.description === undefined
          ) {
            return toolError(
              TOOL_ERROR_CODES.INVALID_ARGS,
              "Name the collection to fill (collectionKey) or the one to create (key + label + description).",
            );
          }
          const created = await createCollection({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            key: input.key,
            label: input.label,
            description: input.description,
            ...(input.icon === undefined ? {} : { icon: input.icon }),
            ...(userId === null ? {} : { createdByUserId: userId }),
            actor: agentEventActor(ctx),
          });
          collectionId = created.id;
        }

        const source = await createSyncSource({
          organizationId: ctx.organizationId,
          teamId: ctx.teamId,
          userId,
          collectionId,
          kind,
          connectionId: input.connectionId,
          // The service stamps the CONNECTION's provider — see
          // `assertConnectionUsable`. Stated here only because the input type
          // still carries it for the connection-less case.
          providerKey: "",
          operation: input.operation,
          args,
          ...(input.resultPath === undefined
            ? {}
            : { resultPath: input.resultPath }),
          ...(input.externalIdPath === undefined
            ? {}
            : { externalIdPath: input.externalIdPath }),
          fields: input.fields.map(toDraft),
          schedule: input.schedule ?? { mode: "manual" },
          orphanPolicy: input.orphanPolicy ?? "keep",
          ...(input.rowCap === undefined ? {} : { rowCap: input.rowCap }),
        });

        return {
          ok: true,
          sourceId: source.id,
          collectionId,
          note: "The first run has started in the background. Tell the user the collection will fill in a moment, how often it refreshes, and that its columns are read-only here.",
        };
      } catch (error) {
        return toolError(
          TOOL_ERROR_CODES.COLLECTION_QUERY_ERROR,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

/** A tool-shaped field draft → the service's. */
const toDraft = (field: z.infer<typeof fieldDraftSchema>) => ({
  path: field.path,
  label: field.label ?? field.path,
  type: field.type ?? ("text" as const),
  ...(field.key === undefined ? {} : { fieldKey: field.key }),
  ...(field.isTitle === undefined ? {} : { isTitle: field.isTitle }),
});
