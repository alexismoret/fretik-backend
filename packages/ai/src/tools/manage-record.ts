import { recordSharingSchema } from "@fretik/shared/schemas/object-sharing";
import { createObjectRecord } from "@fretik/shared/services/object-records/create";
import { deleteObjectRecord } from "@fretik/shared/services/object-records/delete";
import { setRecordStatus } from "@fretik/shared/services/object-records/set-status";
import { setRecordData } from "@fretik/shared/services/object-records/update";
import { assertCanWriteRecord } from "@fretik/shared/services/object-sharing/write-access";
import { resolveObjectTypeId } from "@fretik/shared/services/object-types/resolve";
import { tool } from "ai";
import { z } from "zod";
import {
  agentEventActor,
  getRuntimeContext,
} from "../agents/shared/runtime-context";
import { TOOL_ERROR_CODES, toolError } from "../lib/tool-error-codes";

/**
 * `manageRecord` input schema. Exported so the never-fatal contract is unit-
 * tested directly. `value` is string-dominant (`string | string[] | null`),
 * mirroring how Notion/Airtable encode dynamic, user-defined property values:
 * when the value type is uniform (it can't be typed per user-defined field), a
 * STRING is the only LOSSLESS representation — a number `"1500"` loses nothing,
 * a phone keeps its leading `+`, an id keeps its leading zeros. A bare JSON
 * number/boolean is deliberately OUT of the union: it would let the model drop
 * the `+` of `+33611223344` into `33611223344` (a silent wrong write). The rare
 * number/object slip is a RECOVERABLE tool-error (never fatal — see
 * `isRecoverableToolCallError`), then `coerceRecordValue` decodes the string to
 * the column's type server-side. A list of strings is for multi-select.
 */
export const manageRecordInputSchema = z.object({
  action: z.enum(["create", "update", "delete", "setStatus"]),
  typeKey: z
    .string()
    .max(60)
    .optional()
    .describe("Object type slug. Required for create."),
  recordId: z
    .string()
    .optional()
    .describe("Required for update / delete / setStatus."),
  data: z
    .array(
      // `.catchall` keeps a stray key a weak model sometimes emits (e.g. the
      // value under `item` instead of `value`) so `resolveRecordValues` can
      // recover it instead of the SDK rejecting the call. `value` is optional
      // only as that recovery net — every entry MUST carry a value (the
      // description says so); a genuinely value-less entry is taught, not
      // silently dropped.
      z
        .object({
          key: z.string().describe("Field key."),
          value: z
            .union([z.string(), z.array(z.string()), z.null()])
            .optional()
            .describe(
              'The value as a string — quote everything (numbers, dates, booleans, money, phone, ids), keeping any leading + or zeros: "1500", "2025-01-31", "true", "1500 EUR", "+33611223344". A list of strings for multi-select. null clears it.',
            ),
        })
        .catchall(z.unknown()),
    )
    .optional()
    .describe(
      'Field values as a list of { key, value } — one per field, each with its value. Keys are the type\'s field keys. e.g. [{"key":"amount","value":"1500"}]. Required for create / update.',
    ),
  status: z.enum(["confirmed", "rejected"]).optional(),
  labelOverride: z
    .string()
    .optional()
    .describe("Force the label instead of deriving it from a field."),
  relations: z
    .array(
      z.object({
        relationKey: z
          .string()
          .max(60)
          .describe("Relation slug, e.g. 'works_for'."),
        toRecordId: z.string().optional().describe("Target record id."),
        toDocumentId: z
          .string()
          .optional()
          .describe("Target = this uploaded file's document record."),
      }),
    )
    .optional()
    .describe(
      "On create only: outgoing relations to attach in the same write. Each links the new record to a target record (toRecordId) or uploaded file (toDocumentId).",
    ),
  sharing: recordSharingSchema
    .optional()
    .describe(
      "Cross-team sharing (owner team only). Omit to follow the type's audience (default). { inherit: false, audience: { mode: 'internal' | 'org' | 'teams', … } } overrides — a record can only be shared with teams that already have the type. Reset with { inherit: true }.",
    ),
});

type RecordDataEntry = { key: string } & Record<string, unknown>;

/**
 * Turn the model's `{ key, value }` list into the `{ key: value }` map the
 * services take. Tolerant of the one slip weak models make: the value placed
 * under a stray key (e.g. `{ key: "regions", item: "apac" }`). When `value` is
 * absent but exactly one other property carries it, that property IS the value
 * — recovered so the call succeeds first try instead of an SDK rejection. An
 * entry with no resolvable value is reported in `missing` (taught, never
 * silently dropped). An explicit `null` value is kept (it clears the field).
 */
export const resolveRecordValues = (
  data: readonly RecordDataEntry[],
): { values: Record<string, unknown>; missing: string[] } => {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const entry of data) {
    if (entry.value !== undefined) {
      values[entry.key] = entry.value;
      continue;
    }
    const strays = Object.entries(entry).filter(
      ([k, v]) => k !== "key" && k !== "value" && v !== undefined,
    );
    const stray = strays.length === 1 ? strays[0] : undefined;
    if (stray) {
      values[entry.key] = stray[1];
    } else {
      missing.push(entry.key);
    }
  }
  return { values, missing };
};

/**
 * Domain tool (deferred) — write ONE object record (create / update / delete /
 * setStatus) through the validated shared services, so field validation, the
 * typed table, and the `domain_events` journal stay consistent. Bulk writes go
 * through the Python `objects.records` SDK (fretik_apps), not this tool.
 */
export const createManageRecordTool = () =>
  tool({
    description: [
      "Write ONE object record. Schema-validated and journaled; team-scoped.",
      "",
      "- create: typeKey + data (+ optional relations to link in the same write). Born confirmed.",
      "- update: recordId + data. PATCH — only the fields you pass change; omitted ones are kept (value null clears one).",
      "- delete: recordId.",
      "- setStatus: recordId + status ('confirmed' accepts an AI suggestion, 'rejected' retires it).",
      "",
      "`data` is a list of { key, value } — keys are the type's field keys (describeObjectType). For many rows, use the python `objects.records` SDK.",
      "Records follow their type's audience by default; `sharing` overrides it (owner team only, and only to teams that already have the type). Propose with askUserQuestion before sharing beyond the team.",
    ].join("\n"),
    inputSchema: manageRecordInputSchema,
    execute: async (input, options) => {
      const ctx = getRuntimeContext(options);
      const actor = agentEventActor(ctx);
      // The model passes values as a { key, value } list (reliable to fill);
      // the services take a map. `resolveRecordValues` recovers a value the
      // model put under a stray key and flags entries with no value at all.
      const { values, missing } = resolveRecordValues(input.data ?? []);
      if (
        missing.length > 0 &&
        (input.action === "create" || input.action === "update")
      ) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `Missing value for: ${missing.join(", ")}. Send each field as {"key":"…","value":"…"}.`,
        );
      }

      try {
        if (input.action === "create") {
          if (!input.typeKey || Object.keys(values).length === 0) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "create requires typeKey and data.",
            );
          }
          const objectTypeId = await resolveObjectTypeId({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            key: input.typeKey,
          });
          if (!objectTypeId) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_TYPE_NOT_FOUND,
              `No object type '${input.typeKey}' for this team.`,
              "Check the available type keys in <team_objects>.",
            );
          }
          const record = await createObjectRecord({
            organizationId: ctx.organizationId,
            teamId: ctx.teamId,
            userId: ctx.userId ?? null,
            objectTypeId,
            data: values,
            labelOverride: input.labelOverride ?? null,
            relations: input.relations,
            sharing: input.sharing,
            actor,
          });
          return { ok: true, record: serializeRecord(record) };
        }

        if (!input.recordId) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            `${input.action} requires recordId.`,
          );
        }

        // Owner team or a write grant/share — never write another team's record.
        await assertCanWriteRecord({
          recordId: input.recordId,
          teamId: ctx.teamId,
          organizationId: ctx.organizationId,
        });

        if (input.action === "update") {
          const hasData = Object.keys(values).length > 0;
          if (!hasData && input.labelOverride == null && !input.sharing) {
            return toolError(
              TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
              "update requires data naming the field(s) to set, labelOverride to set the display label, or sharing to change the audience.",
            );
          }
          // Patch: only the named fields change; omitted ones are kept.
          // labelOverride forces the display label; sharing changes the audience
          // (owner team only — enforced via callerTeamId).
          const record = await setRecordData({
            id: input.recordId,
            data: hasData || input.labelOverride != null ? values : undefined,
            merge: true,
            labelOverride: input.labelOverride ?? null,
            sharing: input.sharing,
            callerTeamId: ctx.teamId,
            actor,
          });
          return { ok: true, record: serializeRecord(record) };
        }

        if (input.action === "delete") {
          const result = await deleteObjectRecord({
            id: input.recordId,
            actor,
          });
          return { ok: true, ...result };
        }

        if (!input.status) {
          return toolError(
            TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
            "setStatus requires status ('confirmed' | 'rejected').",
          );
        }
        const record = await setRecordStatus({
          id: input.recordId,
          status: input.status,
          actor,
        });
        return { ok: true, record: serializeRecord(record) };
      } catch (err) {
        return toolError(
          TOOL_ERROR_CODES.OBJECT_QUERY_ERROR,
          `manageRecord ${input.action} failed: ${errMsg(err)}`,
        );
      }
    },
  });

const serializeRecord = (r: {
  id: string;
  label: string;
  status: string;
  data: Record<string, unknown>;
}) => ({ id: r.id, label: r.label, status: r.status, data: r.data });

const errMsg = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
