import { z } from "zod";
import type {
  ToolApprovalRecordWriteItem,
  ToolApprovalRecordWritePayload,
} from "../../db/schema";
import { MAX_BULK_ITEMS } from "../../lib/db-bulk";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "../../schemas/field-definitions";
import { audienceSchema } from "../../schemas/object-sharing";
import { recordRelationInputSchema } from "../../schemas/ontology";
import type { WorkflowAutonomy } from "../../schemas/workflows";
import { createPendingRecordWriteApproval } from "../approvals/create-pending-record-write";
import { runApprovalGate } from "../approvals/gate";
import { recordWriteLookupHash } from "../approvals/hash";
import type { EventActor } from "../domain-events/emit";
import { FIELD_DEFINITION_LIMITS } from "../field-definitions/constants";
import { createFieldDefinition } from "../field-definitions/create";
import { deleteFieldDefinition } from "../field-definitions/delete";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { updateFieldDefinition } from "../field-definitions/update";
import { bulkCreateObjectRecords } from "../object-records/bulk-create";
import { bulkDeleteObjectRecords } from "../object-records/bulk-delete";
import { bulkUpdateObjectRecords } from "../object-records/bulk-update";
import { queryObjectRecords } from "../object-records/query";
import { getRecordSnapshots } from "../object-records/snapshot-batch";
import { OBJECT_TYPE_LIMITS } from "../object-types/constants";
import { createObjectType } from "../object-types/create";
import { createObjectTypeWithFields } from "../object-types/create-with-fields";
import { deleteObjectType } from "../object-types/delete";
import { resolveObjectTypeId } from "../object-types/resolve";
import { updateObjectType } from "../object-types/update";
import { getWorkflowAutonomyForConversation } from "../workflows/get-run-autonomy";
import type { ExecContext, SandboxExecResponse } from "./types";

/**
 * `kind: "objects"` dispatch for `POST /sandbox/exec` — the server side of the
 * Python `fretik_apps.objects` SDK (code-mode). The bulk / migration power path:
 * the agent writes ONE in-sandbox script (create a type, move records between
 * types, insert hundreds of rows) and only a small result summary re-enters its
 * context.
 *
 * Every op goes through the SAME validated shared services as the domain tools
 * (`manageRecord` / `manageObjectType` / `manageField`), so field validation,
 * the typed extension table, and `domain_events` stay consistent and auditable.
 * Record ops use the batch services (`bulk{Create,Update,Delete}ObjectRecords`)
 * — one set-based statement per chunk, no per-row SQL. Tenancy is pinned by the
 * sandbox JWT: type resolution is team-scoped and the bulk services drop any
 * record id not owned by the JWT's team.
 *
 * Workflow autonomy gates the writes (`getWorkflowAutonomyForConversation`):
 * `read_only` rejects; `approval_required` routes record writes through the
 * generic approval gate (a pending `record_write` the user reviews); schema
 * changes are blocked for any run. Plain chat + `autonomous` write directly.
 */
// Ops executed through the sandbox exec seam attribute as `connector`, keeping
// the driving user + conversation for provenance.
const execActor = (ctx: ExecContext): EventActor => ({
  actorType: "connector",
  actorUserId: ctx.userId,
  conversationId: ctx.conversationId,
});

export const dispatchObjects = async (
  ctx: ExecContext,
  op: string,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const actor = execActor(ctx);
  // Resolve the run's write-autonomy once: `null` = plain chat (direct writes),
  // else a workflow run whose mode gates record writes + schema changes.
  const autonomy = await getWorkflowAutonomyForConversation(ctx.conversationId);

  // A run never changes the team's object schema — hard rule, mirrors the
  // workflow executor excluding `manageObjectType`/`manageField`.
  if (op.startsWith("schema.") && autonomy !== null) {
    return {
      status: "error",
      message:
        "SCHEMA_LOCKED_IN_WORKFLOW: a run never changes the team's object schema. Do schema migrations from chat.",
    };
  }

  try {
    switch (op) {
      case "records.bulk_create":
        return await bulkCreate(ctx, actor, autonomy, rawArgs);
      case "records.bulk_update":
        return await bulkUpdate(ctx, actor, autonomy, rawArgs);
      case "records.bulk_delete":
        return await bulkDelete(ctx, actor, autonomy, rawArgs);
      case "records.query":
        return await queryRecords(ctx, rawArgs);
      case "schema.create_type":
        return await createType(ctx, rawArgs);
      case "schema.update_type":
        return await updateType(ctx, rawArgs);
      case "schema.add_field":
        return await addField(ctx, rawArgs);
      case "schema.change_field":
        return await changeField(ctx, rawArgs);
      case "schema.delete_type":
        return await deleteType(ctx, rawArgs);
      default:
        return { status: "error", message: `Unknown objects op: ${op}` };
    }
  } catch (error) {
    return { status: "error", message: errMsg(error) };
  }
};

const READ_ONLY_MSG =
  "READ_ONLY_WORKFLOW: this run cannot write records. Note in the task summary what would have been written.";

/**
 * Gate one bulk record write by autonomy: `read_only` rejects; `autonomous` and
 * plain chat (`null`) write directly (no approval row); `approval_required`
 * routes through the generic approval gate — a pending `record_write` approval
 * that pauses the run, and on a re-run of the same code replays the consumed
 * result. `buildPayload` is LAZY (its snapshot/metadata reads run only when a
 * fresh pending is actually created).
 */
const gateRecordWrite = (params: {
  ctx: ExecContext;
  autonomy: WorkflowAutonomy | null;
  op: ToolApprovalRecordWritePayload["op"];
  objectTypeId?: string;
  merge?: boolean;
  hashItems: ToolApprovalRecordWriteItem[];
  buildPayload: () => Promise<ToolApprovalRecordWritePayload>;
  directWrite: () => Promise<SandboxExecResponse>;
  /** Pre-approval dry-run: validate the rows before a human is asked to grant
   * (create/update; delete has nothing to validate). Reuses the bulk services'
   * own validation via their `dryRun` flag. */
  validateBeforePending?: () => Promise<{ index: number; error: string }[]>;
}): Promise<SandboxExecResponse> => {
  if (params.autonomy === "read_only") {
    return Promise.resolve({ status: "error", message: READ_ONLY_MSG });
  }
  if (params.autonomy !== "approval_required") {
    return params.directWrite();
  }
  const lookupHash = recordWriteLookupHash({
    op: params.op,
    objectTypeId: params.objectTypeId,
    merge: params.merge,
    items: params.hashItems,
  });
  return runApprovalGate({
    ctx: params.ctx,
    kind: "record_write",
    autonomy: params.autonomy,
    lookupHash,
    createPending: async () =>
      createPendingRecordWriteApproval({
        organizationId: params.ctx.organizationId,
        teamId: params.ctx.teamId,
        userId: params.ctx.userId,
        conversationId: params.ctx.conversationId,
        turnId: params.ctx.turnId,
        lookupHash,
        payload: await params.buildPayload(),
      }),
    ...(params.validateBeforePending !== undefined
      ? { validateBeforePending: params.validateBeforePending }
      : {}),
  });
};

// ── Record ops (fully batched — one set-based statement per chunk) ─────

const bulkCreateArgs = z.object({
  typeKey: z.string().min(1).max(60),
  // Each row is its field `data` plus optional outgoing `relations`. Created in
  // one batched pass (records, then their links).
  rows: z
    .array(
      z.object({
        data: z.record(z.string(), z.unknown()),
        relations: z.array(recordRelationInputSchema).optional(),
      }),
    )
    .min(1)
    .max(MAX_BULK_ITEMS),
});

const bulkCreate = async (
  ctx: ExecContext,
  actor: EventActor,
  autonomy: WorkflowAutonomy | null,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { typeKey, rows } = bulkCreateArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, typeKey);
  if (objectTypeId === null) return unknownType(typeKey);

  return gateRecordWrite({
    ctx,
    autonomy,
    op: "create",
    objectTypeId,
    hashItems: rows.map((r) => ({ data: r.data, relations: r.relations })),
    validateBeforePending: async () => {
      const { errors } = await bulkCreateObjectRecords({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        objectTypeId,
        rows,
        dryRun: true,
      });
      return errors;
    },
    buildPayload: () =>
      Promise.resolve({
        op: "create",
        typeKey,
        objectTypeId,
        items: rows.map((r) => ({
          data: r.data,
          relations: r.relations,
          objectTypeId,
          typeKey,
        })),
      }),
    directWrite: async () => {
      const result = await bulkCreateObjectRecords({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        objectTypeId,
        rows,
        actor,
      });
      return {
        status: "ok",
        data: {
          ids: result.ids,
          okCount: result.ids.filter((id) => id !== null).length,
          errors: result.errors,
          relationErrors: result.relationErrors,
        },
      };
    },
  });
};

const bulkUpdateArgs = z.object({
  updates: z
    .array(
      z.object({
        id: z.string().min(1),
        data: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(MAX_BULK_ITEMS),
  merge: z.boolean().optional(),
});

const bulkUpdate = async (
  ctx: ExecContext,
  actor: EventActor,
  autonomy: WorkflowAutonomy | null,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { updates, merge } = bulkUpdateArgs.parse(rawArgs);

  return gateRecordWrite({
    ctx,
    autonomy,
    op: "update",
    merge,
    hashItems: updates.map((u) => ({ recordId: u.id, data: u.data })),
    validateBeforePending: async () => {
      const { errors } = await bulkUpdateObjectRecords({
        teamId: ctx.teamId,
        updates,
        merge,
        dryRun: true,
      });
      // Map the bulk service's id-keyed errors to the payload's positional
      // items so the agent sees which update failed.
      const indexById = new Map(updates.map((u, i) => [u.id, i]));
      return errors.map((e) => ({
        index: indexById.get(e.id) ?? -1,
        error: e.error,
      }));
    },
    buildPayload: async () => {
      const snapshots = await getRecordSnapshots({
        teamId: ctx.teamId,
        ids: updates.map((u) => u.id),
      });
      return {
        op: "update",
        merge,
        items: updates.map((u) => {
          const s = snapshots.get(u.id);
          return {
            recordId: u.id,
            data: u.data,
            currentLabel: s?.label,
            currentData: s?.data,
            objectTypeId: s?.objectTypeId,
          };
        }),
      };
    },
    directWrite: async () => {
      const result = await bulkUpdateObjectRecords({
        teamId: ctx.teamId,
        updates,
        merge,
        actor,
      });
      return {
        status: "ok",
        data: {
          updatedIds: result.updatedIds,
          okCount: result.updatedIds.length,
          errors: result.errors,
        },
      };
    },
  });
};

const bulkDeleteArgs = z.object({
  recordIds: z.array(z.string().min(1)).min(1).max(MAX_BULK_ITEMS),
});

const bulkDelete = async (
  ctx: ExecContext,
  actor: EventActor,
  autonomy: WorkflowAutonomy | null,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { recordIds } = bulkDeleteArgs.parse(rawArgs);

  return gateRecordWrite({
    ctx,
    autonomy,
    op: "delete",
    hashItems: recordIds.map((id) => ({ recordId: id })),
    buildPayload: async () => {
      const snapshots = await getRecordSnapshots({
        teamId: ctx.teamId,
        ids: recordIds,
      });
      return {
        op: "delete",
        items: recordIds.map((id) => {
          const s = snapshots.get(id);
          return {
            recordId: id,
            currentLabel: s?.label,
            currentData: s?.data,
            objectTypeId: s?.objectTypeId,
          };
        }),
      };
    },
    directWrite: async () => {
      const result = await bulkDeleteObjectRecords({
        teamId: ctx.teamId,
        ids: recordIds,
        actor,
      });
      return {
        status: "ok",
        data: {
          deletedIds: result.deletedIds,
          okCount: result.deletedIds.length,
          errors: result.errors,
        },
      };
    },
  });
};

const queryArgs = z.object({
  typeKey: z.string().min(1).max(60),
  filters: z.record(z.string(), z.unknown()).optional(),
  page: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const queryRecords = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { typeKey, filters, page, limit } = queryArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, typeKey);
  if (objectTypeId === null) return unknownType(typeKey);

  const records = await queryObjectRecords({
    teamId: ctx.teamId,
    objectTypeId,
    filters,
    page,
    limit: limit ?? 200,
  });
  return {
    status: "ok",
    data: {
      records: records.map((r) => ({
        id: r.id,
        label: r.label,
        status: r.status,
        data: r.data,
      })),
    },
  };
};

// ── Schema ops ────────────────────────────────────────────────────────
//
// Field changes are DDL (`ALTER TABLE`) — inherently one statement per column,
// so a multi-field op runs them in sequence. That is NOT the "SQL in a loop"
// hazard the bulk record path avoids: field counts are tiny (dozens at most),
// and the win here is one SDK round-trip, not one DB statement.

const fieldInputSchema = z.object({
  label: z.string().min(1),
  type: fieldDefinitionTypeSchema,
  // One line — what this field holds. Required (the agent reads it as ground truth).
  description: z
    .string()
    .min(1)
    .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS),
  config: fieldConfigSchema.optional(),
  isTitle: z.boolean().optional(),
});

const createTypeArgs = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1),
  labelPlural: z.string().nullish(),
  // One line — what this type is for. Required on create.
  description: z.string().min(1).max(OBJECT_TYPE_LIMITS.MAX_DESCRIPTION_CHARS),
  icon: z.string().nullish(),
  // Cross-team audience. Omit = internal (owning team only).
  sharing: audienceSchema.optional(),
  fields: z.array(fieldInputSchema).optional(),
});

/**
 * Create an object type (provisions its typed table). Pass `fields` to build the
 * whole schema atomically — the migration entry point when splitting one type
 * into several. Colors are auto-assigned server-side.
 */
const createType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = createTypeArgs.parse(rawArgs);
  if (args.fields && args.fields.length > 0) {
    const created = await createObjectTypeWithFields({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      key: args.key,
      label: args.label,
      labelPlural: args.labelPlural ?? null,
      description: args.description ?? null,
      icon: args.icon ?? null,
      color: null,
      sharing: args.sharing,
      createdByUserId: ctx.userId,
      fields: args.fields.map((f) => ({
        label: f.label,
        type: f.type,
        description: f.description ?? null,
        config: f.config,
        isTitle: f.isTitle,
      })),
    });
    return {
      status: "ok",
      data: {
        id: created.id,
        key: created.key,
        fields: created.fieldDefinitions.map((f) => ({
          key: f.key,
          type: f.type,
        })),
      },
    };
  }
  const type = await createObjectType({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key: args.key,
    label: args.label,
    labelPlural: args.labelPlural ?? null,
    description: args.description ?? null,
    icon: args.icon ?? null,
    color: null,
    sharing: args.sharing,
    createdByUserId: ctx.userId,
    actor: execActor(ctx),
  });
  return { status: "ok", data: { id: type.id, key: type.key, fields: [] } };
};

const updateTypeArgs = z.object({
  typeKey: z.string().min(1).max(60),
  label: z.string().optional(),
  labelPlural: z.string().nullish(),
  description: z
    .string()
    .max(OBJECT_TYPE_LIMITS.MAX_DESCRIPTION_CHARS)
    .nullish(),
  icon: z.string().nullish(),
  enabled: z.boolean().optional(),
  // Change the cross-team audience (owner team only).
  sharing: audienceSchema.optional(),
  addFields: z.array(fieldInputSchema).optional(),
});

/**
 * Update an object type in one call: patch its presentation/lifecycle metadata
 * AND/OR add several new fields at once (`addFields`). Editing or removing
 * existing fields is `change_field`; this op only grows the schema.
 */
const updateType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = updateTypeArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, args.typeKey);
  if (objectTypeId === null) return unknownType(args.typeKey);

  const hasMetadata =
    args.label !== undefined ||
    args.labelPlural !== undefined ||
    args.description !== undefined ||
    args.icon !== undefined ||
    args.enabled !== undefined;
  if (hasMetadata || args.sharing) {
    await updateObjectType({
      id: objectTypeId,
      patch: {
        label: args.label,
        labelPlural: args.labelPlural,
        description: args.description,
        icon: args.icon,
        enabled: args.enabled,
      },
      sharing: args.sharing,
      callerTeamId: ctx.teamId,
      createdByUserId: ctx.userId,
      actor: execActor(ctx),
    });
  }

  const addedFields: { key: string; type: string }[] = [];
  for (const f of args.addFields ?? []) {
    const field = await createFieldDefinition({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      objectTypeId,
      label: f.label,
      type: f.type,
      config: f.config,
      description: f.description ?? null,
      isTitle: f.isTitle,
      actor: execActor(ctx),
    });
    addedFields.push({ key: field.key, type: field.type });
  }

  return { status: "ok", data: { key: args.typeKey, addedFields } };
};

const addFieldArgs = z.object({
  typeKey: z.string().min(1).max(60),
  label: z.string().min(1),
  type: fieldDefinitionTypeSchema,
  // One line — what this field holds. Required.
  description: z
    .string()
    .min(1)
    .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS),
  config: fieldConfigSchema.optional(),
});

const addField = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = addFieldArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, args.typeKey);
  if (objectTypeId === null) return unknownType(args.typeKey);

  const field = await createFieldDefinition({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    objectTypeId,
    label: args.label,
    type: args.type,
    config: args.config,
    description: args.description ?? null,
    actor: execActor(ctx),
  });
  return { status: "ok", data: { key: field.key, type: field.type } };
};

const changeFieldArgs = z.object({
  typeKey: z.string().min(1).max(60),
  fieldKey: z.string().min(1).max(60),
  action: z.enum(["update", "changeType", "delete"]),
  label: z.string().nullish(),
  description: z
    .string()
    .max(FIELD_DEFINITION_LIMITS.MAX_DESCRIPTION_CHARS)
    .nullish(),
  config: fieldConfigSchema.optional(),
  type: fieldDefinitionTypeSchema.optional(),
  enabled: z.boolean().optional(),
  cascade: z.boolean().optional(),
});

/**
 * Edit one field. `update` keeps stored values; `changeType` RESETS them
 * (add-new-column → drop-old, no in-place ALTER TYPE); `delete` drops the column
 * (`cascade` required when it holds values).
 */
const changeField = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = changeFieldArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, args.typeKey);
  if (objectTypeId === null) return unknownType(args.typeKey);

  const fields = await getFieldDefinitionsForTeam({
    teamId: ctx.teamId,
    objectTypeId,
    includeDisabled: true,
  });
  const field = fields.find((f) => f.key === args.fieldKey);
  if (!field) {
    return {
      status: "error",
      message: `No field '${args.fieldKey}' on type '${args.typeKey}'.`,
    };
  }

  if (args.action === "delete") {
    const result = await deleteFieldDefinition({
      id: field.id,
      cascade: args.cascade ?? false,
      actor: execActor(ctx),
    });
    return { status: "ok", data: result };
  }

  if (args.action === "changeType") {
    if (!args.type) {
      return { status: "error", message: "changeType requires type." };
    }
    const updated = await updateFieldDefinition({
      id: field.id,
      cascade: true,
      patch: { type: args.type, config: args.config },
      actor: execActor(ctx),
    });
    return { status: "ok", data: { key: updated.key, type: updated.type } };
  }

  const updated = await updateFieldDefinition({
    id: field.id,
    patch: {
      label: args.label ?? undefined,
      description: args.description,
      config: args.config,
      enabled: args.enabled,
    },
    actor: execActor(ctx),
  });
  return { status: "ok", data: { key: updated.key, type: updated.type } };
};

const deleteTypeArgs = z.object({ typeKey: z.string().min(1).max(60) });

/** Drop a type and every record in it. The last step of a merge/split. */
const deleteType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { typeKey } = deleteTypeArgs.parse(rawArgs);
  const objectTypeId = await resolveTeamType(ctx, typeKey);
  if (objectTypeId === null) return unknownType(typeKey);

  const result = await deleteObjectType({
    id: objectTypeId,
    actor: execActor(ctx),
  });
  return { status: "ok", data: result };
};

// ── Helpers ───────────────────────────────────────────────────────────

const resolveTeamType = (
  ctx: ExecContext,
  key: string,
): Promise<string | null> =>
  resolveObjectTypeId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key,
  });

const unknownType = (key: string): SandboxExecResponse => ({
  status: "error",
  message: `No object type '${key}' for this team. List types first.`,
});

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
