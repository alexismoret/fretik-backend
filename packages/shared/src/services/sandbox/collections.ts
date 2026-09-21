import { z } from "zod";
import type { BulkOperation, BulkOperationParams } from "../../db/schema";
import { MAX_BULK_ITEMS } from "../../lib/db-bulk";
import { audienceSchema } from "../../schemas/collection-sharing";
import {
  SYNC_LIMITS,
  syncArgsSchema,
  syncKindSchema,
  syncOrphanPolicySchema,
  syncScheduleSchema,
} from "../../schemas/collection-sync";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "../../schemas/field-definitions";
import { recordRelationInputSchema } from "../../schemas/ontology";
import type { ToolPolicyLevel } from "../../schemas/tool-policies";
import type { WorkflowAutonomy } from "../../schemas/workflows";
import {
  SYNC_LOCKED_IN_WORKFLOW,
  TOOL_PERMISSIONS_REMEDIATION,
} from "../ai/remediation";
import { gateRecordWriteApproval } from "../approvals/gate-record-write";
import { recordImportLookupHash } from "../approvals/hash";
import {
  beginBulkOperation,
  MAX_BULK_OPERATION_ITEMS,
} from "../bulk-operations/begin";
import {
  applyChunk,
  chunkAlreadyApplied,
  claimChunk,
} from "../bulk-operations/chunk";
import { commitBulkOperation } from "../bulk-operations/commit";
import { firstMalformedRow } from "../bulk-operations/executors/rows";
import { findBulkOperation } from "../bulk-operations/find";
import { emptyProgress, foldChunkProgress } from "../bulk-operations/progress";
import { resumeBulkOperation } from "../bulk-operations/resume";
import { updateBulkOperationProgress } from "../bulk-operations/runner";
import { importToolOutput } from "../bulk-operations/tool-output";
import {
  bulkCreateCollectionRecords,
  recordWriteChunkSize,
} from "../collection-records/bulk-create";
import { bulkDeleteCollectionRecords } from "../collection-records/bulk-delete";
import {
  bulkUpdateCollectionRecords,
  recordUpdateChunkSize,
} from "../collection-records/bulk-update";
import { queryCollectionRecords } from "../collection-records/query";
import { getRecordSnapshots } from "../collection-records/snapshot-batch";
import { confirmFullResync } from "../collection-sync/confirm-full-resync";
import { createSyncSource } from "../collection-sync/create-source";
import { deleteSyncSource } from "../collection-sync/delete-source";
import { listSyncSources } from "../collection-sync/list-sources";
import { previewSyncSource } from "../collection-sync/preview";
import { requestSyncRefresh } from "../collection-sync/request-refresh";
import { updateSyncSource } from "../collection-sync/update-source";
import { COLLECTION_LIMITS } from "../collections/constants";
import { createCollection } from "../collections/create";
import { createCollectionWithFields } from "../collections/create-with-fields";
import { deleteCollection } from "../collections/delete";
import { resolveCollectionId } from "../collections/resolve";
import { updateCollection } from "../collections/update";
import type { EventActor } from "../domain-events/emit";
import { FIELD_DEFINITION_LIMITS } from "../field-definitions/constants";
import { createFieldDefinition } from "../field-definitions/create";
import { deleteFieldDefinition } from "../field-definitions/delete";
import { getFieldDefinitionsForTeam } from "../field-definitions/get-for-team";
import { updateFieldDefinition } from "../field-definitions/update";
import { getTeamToolPolicies } from "../tool-policies/get-for-team";
import { resolveBuiltinToolPolicy } from "../tool-policies/resolve";
import { getWorkflowRunContext } from "../workflows/run-context";
import type { ExecContext, SandboxExecResponse } from "./types";

/**
 * `kind: "collections"` dispatch for `POST /sandbox/exec` — the server side of the
 * Python `fretik_apps.collections` SDK (code-mode). The bulk / migration power path:
 * the agent writes ONE in-sandbox script (create a type, move records between
 * types, insert hundreds of rows) and only a small result summary re-enters its
 * context.
 *
 * Every op goes through the SAME validated shared services as the domain tools
 * (`manageRecord` / `manageCollection` / `manageField`), so field validation,
 * the typed extension table, and `domain_events` stay consistent and auditable.
 * Record ops use the batch services (`bulk{Create,Update,Delete}CollectionRecords`)
 * — one set-based statement per chunk, no per-row SQL. Tenancy is pinned by the
 * sandbox JWT: type resolution is team-scoped and the bulk services drop any
 * record id not owned by the JWT's team.
 *
 * Workflow autonomy gates the writes (`getWorkflowRunContext`):
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

export const dispatchCollections = async (
  ctx: ExecContext,
  op: string,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const actor = execActor(ctx);
  // Resolve the run's write-autonomy once: `null` = plain chat (direct writes),
  // else a workflow run whose mode gates record writes + schema changes.
  const autonomy =
    (await getWorkflowRunContext(ctx.conversationId))?.autonomy ?? null;
  // The team's tool-permission map — the Python objects SDK bypasses the domain
  // tools, so it must consult the SAME policy (`manageRecord` for record writes,
  // `manageCollection`/`manageField` for schema) to stay coherent.
  const teamPolicies = await getTeamToolPolicies(ctx.teamId);

  // A run never changes the team's collection schema — hard rule, mirrors the
  // workflow executor excluding `manageCollection`/`manageField`.
  if (op.startsWith("schema.") && autonomy !== null) {
    return {
      status: "error",
      message:
        "SCHEMA_LOCKED_IN_WORKFLOW: a run never changes the team's collection schema. Do schema migrations from chat.",
    };
  }
  // Declaring a source IS a schema change — it creates columns and commits the
  // team to calling a third party on a cadence — so a run may not, for the
  // same reason. Refreshing is a read and stays allowed.
  if (
    op.startsWith("sync.") &&
    op !== "sync.refresh" &&
    op !== "sync.list" &&
    op !== "sync.preview" &&
    autonomy !== null
  ) {
    return {
      status: "error",
      message: `SYNC_LOCKED_IN_WORKFLOW: ${SYNC_LOCKED_IN_WORKFLOW}`,
    };
  }
  // In chat, the config-tool policy governs schema edits — blocked outright, or
  // approval-gated for the destructive actions. Resolve with the action this op
  // carries, so this SDK cannot do what the domain tool would have to ask for.
  if (op.startsWith("schema.")) {
    const schemaTool =
      op === "schema.add_field" || op === "schema.change_field"
        ? "manageField"
        : "manageCollection";
    const schemaAction =
      op === "schema.delete_collection"
        ? "delete"
        : op === "schema.change_field" && typeof rawArgs.action === "string"
          ? rawArgs.action
          : undefined;
    const level = resolveBuiltinToolPolicy({
      toolName: schemaTool,
      ...(schemaAction === undefined ? {} : { action: schemaAction }),
      teamPolicies,
      autonomy,
    });
    if (level === "blocked") {
      return {
        status: "error",
        message: `SCHEMA_DISABLED: the team disabled ${schemaTool}. ${TOOL_PERMISSIONS_REMEDIATION}`,
      };
    }
    if (level === "approval") {
      return {
        status: "error",
        message: `SCHEMA_CHANGE_NEEDS_APPROVAL: this destroys stored data and needs the user's approval, which this SDK cannot open. Call the ${schemaTool} tool instead.`,
      };
    }
  }

  try {
    switch (op) {
      case "records.bulk_create":
        return await bulkCreate(ctx, actor, autonomy, teamPolicies, rawArgs);
      case "records.bulk_update":
        return await bulkUpdate(ctx, actor, autonomy, teamPolicies, rawArgs);
      case "records.bulk_delete":
        return await bulkDelete(ctx, actor, autonomy, teamPolicies, rawArgs);
      case "records.import_begin":
        return await importBegin(ctx, autonomy, teamPolicies, rawArgs);
      case "records.import_chunk":
        return await importChunk(ctx, rawArgs);
      case "records.import_commit":
        return await importCommit(ctx, rawArgs);
      case "records.query":
        return await queryRecords(ctx, rawArgs);
      case "schema.create_collection":
        return await createType(ctx, rawArgs);
      case "schema.update_collection":
        return await updateType(ctx, rawArgs);
      case "schema.add_field":
        return await addField(ctx, rawArgs);
      case "schema.change_field":
        return await changeField(ctx, rawArgs);
      case "schema.delete_collection":
        return await deleteType(ctx, rawArgs);
      case "sync.preview":
        return await syncPreview(ctx, rawArgs);
      case "sync.create":
        return await syncCreate(ctx, rawArgs);
      case "sync.update":
        return await syncUpdate(ctx, rawArgs);
      case "sync.delete":
        return await syncDelete(ctx, rawArgs);
      case "sync.refresh":
        return await syncRefresh(ctx, rawArgs);
      case "sync.confirmFullResync":
        return await syncConfirmFullResync(ctx, rawArgs);
      case "sync.list":
        return await syncList(ctx, rawArgs);
      default:
        return { status: "error", message: `Unknown objects op: ${op}` };
    }
  } catch (error) {
    return { status: "error", message: errMsg(error) };
  }
};

// ── Record ops (fully batched — one set-based statement per chunk) ─────

const bulkCreateArgs = z.object({
  collectionKey: z.string().min(1).max(60),
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
  teamPolicies: Record<string, ToolPolicyLevel>,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { collectionKey, rows } = bulkCreateArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, collectionKey);
  if (collectionId === null) return unknownType(collectionKey);

  return gateRecordWriteApproval({
    ctx,
    autonomy,
    teamPolicies,
    op: "create",
    collectionId,
    hashItems: rows.map((r) => ({ data: r.data, relations: r.relations })),
    validateBeforePending: async () => {
      const { errors } = await bulkCreateCollectionRecords({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        collectionId,
        rows,
        dryRun: true,
      });
      return errors;
    },
    buildPayload: () =>
      Promise.resolve({
        op: "create",
        collectionKey,
        collectionId,
        items: rows.map((r) => ({
          data: r.data,
          relations: r.relations,
          collectionId,
          collectionKey,
        })),
      }),
    directWrite: async () => {
      const result = await bulkCreateCollectionRecords({
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        collectionId,
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
  teamPolicies: Record<string, ToolPolicyLevel>,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { updates, merge } = bulkUpdateArgs.parse(rawArgs);

  return gateRecordWriteApproval({
    ctx,
    autonomy,
    teamPolicies,
    op: "update",
    merge,
    hashItems: updates.map((u) => ({ recordId: u.id, data: u.data })),
    validateBeforePending: async () => {
      const { errors } = await bulkUpdateCollectionRecords({
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
            collectionId: s?.collectionId,
          };
        }),
      };
    },
    directWrite: async () => {
      const result = await bulkUpdateCollectionRecords({
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
  teamPolicies: Record<string, ToolPolicyLevel>,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { recordIds } = bulkDeleteArgs.parse(rawArgs);

  return gateRecordWriteApproval({
    ctx,
    autonomy,
    teamPolicies,
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
            collectionId: s?.collectionId,
          };
        }),
      };
    },
    directWrite: async () => {
      const result = await bulkDeleteCollectionRecords({
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

// ── Streamed loads (writes too large for one request) ─────────────────
//
// Three ops that only the SDK's `_stream_load` helper calls, and only past
// `SDK_INLINE_ROW_LIMIT` rows. Everything below that keeps using
// `records.bulk_create` / `bulk_update` / `bulk_delete` unchanged — the agent
// never chooses between the two.
//
// The split exists because a 200 000-row write breaks three ceilings at once: a
// single HTTP body, the approval payload a browser can render, and the "one
// pending approval per conversation" rule (40 sequential grants at the old
// 5 000-row cap). Chunking the upload against a `bulk_operations` row fixes all
// three, and turns a crash mid-load into a resume instead of a restart.
//
// All three ops share this path because none of those three ceilings care what
// the rows DO. What changes per op is only the executor, the chunk size and the
// shape of a row — which is why the op is settled here, at begin, and frozen on
// the operation rather than re-stated per chunk.

/** Which streamed op maps to which ledger kind. */
const LOAD_KINDS = {
  create: "record_import",
  update: "record_update",
  delete: "record_delete",
} as const;

const importBeginArgs = z.object({
  op: z.enum(["create", "update", "delete"]),
  collectionKey: z.string().min(1).max(60),
  totalRows: z.number().int().min(1).max(MAX_BULK_OPERATION_ITEMS),
  /** Caller-side digest of the canonicalized rows — the replay key's payload. */
  rowsDigest: z.string().min(16).max(128),
  sample: z.array(z.record(z.string(), z.unknown())).max(10),
  columns: z.array(z.string()).max(200).optional(),
  /** `update` only — patch the provided keys instead of replacing the row. */
  merge: z.boolean().optional(),
});

/**
 * Open (or re-find) a streamed load. Never carries rows: it settles the target
 * type, the policy, the chunk size and what has already been sent, so the
 * caller knows exactly what — if anything — is left to upload.
 */
const importBegin = async (
  ctx: ExecContext,
  autonomy: WorkflowAutonomy | null,
  teamPolicies: Record<string, ToolPolicyLevel>,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = importBeginArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, args.collectionKey);
  if (collectionId === null) return unknownType(args.collectionKey);

  const level = resolveBuiltinToolPolicy({
    toolName: "manageRecord",
    teamPolicies,
    autonomy,
  });
  if (level === "blocked") {
    return {
      status: "error",
      message:
        autonomy === "read_only"
          ? "READ_ONLY_WORKFLOW: this run cannot write records. Note in the task summary what would have been written."
          : `RECORD_WRITES_DISABLED: the team disabled record writes for the assistant. ${TOOL_PERMISSIONS_REMEDIATION}`,
    };
  }

  // Chunk size comes from the TARGET TYPE's real column width, so one uploaded
  // chunk is exactly one database transaction — the property the chunk ledger's
  // exactly-once guard rests on. The insert and the update bind a different
  // number of parameters per row, so each op asks its own write service what a
  // transaction of this collection holds; a delete binds only ids, and sits
  // under the create's bound whatever the collection's width.
  const fieldDefs = await getFieldDefinitionsForTeam({
    teamId: ctx.teamId,
    collectionId,
  });
  const chunkSize =
    args.op === "update"
      ? recordUpdateChunkSize(fieldDefs)
      : recordWriteChunkSize(fieldDefs);

  const merge = args.op === "update" ? (args.merge ?? false) : undefined;
  const lookupHash = recordImportLookupHash({
    op: args.op,
    collectionId,
    totalRows: args.totalRows,
    rowsDigest: args.rowsDigest,
    ...(merge === undefined ? {} : { merge }),
  });

  const params: BulkOperationParams =
    args.op === "update"
      ? {
          op: "update",
          collectionId,
          collectionKey: args.collectionKey,
          merge: merge ?? false,
        }
      : args.op === "delete"
        ? { op: "delete", collectionId, collectionKey: args.collectionKey }
        : { op: "create", collectionId, collectionKey: args.collectionKey };

  const handle = await beginBulkOperation({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    turnId: ctx.turnId,
    kind: LOAD_KINDS[args.op],
    mode: level === "auto" ? "direct" : "staged",
    lookupHash,
    totalItems: args.totalRows,
    chunkSize,
    params,
    sample: args.sample,
    ...(args.columns ? { columns: args.columns } : {}),
  });

  const { operation } = handle;
  if (operation.status === "done") {
    return {
      status: "ok",
      data: { state: "replay", ...importToolOutput(operation, null) },
    };
  }
  if (
    operation.status === "pending_approval" &&
    operation.approvalId !== null
  ) {
    return { status: "approval_pending", approvalId: operation.approvalId };
  }
  if (operation.status === "queued" || operation.status === "running") {
    return {
      status: "ok",
      data: { state: "running", ...importToolOutput(operation, null) },
    };
  }
  // A failed drain is not the end of the load: the applied chunks are stamped,
  // so re-running the same code picks the remaining ones back up under the
  // grant that already covered them. This is the branch the agent lands on
  // after an import died mid-way — refusing here (as this did until
  // 2026-09-03) left a half-imported table with no way forward.
  if (operation.status === "failed") {
    const resumed = await resumeBulkOperation(operation);
    if (resumed.state === "resumed") {
      return {
        status: "ok",
        data: {
          state: "running",
          resumedChunks: resumed.remainingChunks,
          ...importToolOutput(resumed.operation, null),
        },
      };
    }
    if (resumed.state === "nothing_left") {
      return {
        status: "ok",
        data: { state: "replay", ...importToolOutput(operation, null) },
      };
    }
    return { status: "error", message: resumed.reason };
  }
  if (operation.status === "cancelled") {
    // Refused by the user. Re-running is not a recovery, it is asking again.
    return {
      status: "error",
      message:
        operation.error ??
        "This load was cancelled. Ask the user before submitting it again.",
    };
  }

  return {
    status: "ok",
    data: {
      state: "upload",
      operationId: operation.id,
      chunkRows: operation.chunkSize,
      mode: operation.mode,
      // Chunks the caller must NOT re-send. Empty on a first run; on a resume
      // this is what makes re-running the same code cost nothing.
      doneChunks: handle.doneChunks,
    },
  };
};

const importChunkArgs = z.object({
  operationId: z.uuid(),
  chunkIndex: z.number().int().min(0),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(5000),
});

/**
 * Take one chunk. In `direct` mode it is written on the spot and its ids come
 * back; in `staged` mode it is parked until a human grants the whole load.
 */
const importChunk = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = importChunkArgs.parse(rawArgs);
  const operation = await findTeamOperation(ctx, args.operationId);
  if (operation === null) return unknownOperation(args.operationId);
  if (operation.status !== "staging") {
    return {
      status: "error",
      message: `Bulk operation ${operation.id} is ${operation.status} and no longer accepts rows.`,
    };
  }

  const malformed = firstMalformedRow(operation.kind, args.rows);
  if (malformed !== null) {
    return {
      status: "error",
      message: `Row ${(args.chunkIndex * operation.chunkSize + malformed.index).toString()} is not ${malformed.shape}, which is what a ${operation.params.op} load carries. No chunk was stored.`,
    };
  }

  const chunk = await claimChunk({
    operationId: operation.id,
    chunkIndex: args.chunkIndex,
    itemCount: args.rows.length,
    ...(operation.mode === "staged" ? { items: args.rows } : {}),
  });

  if (operation.mode === "staged") {
    return { status: "ok", data: { staged: chunk.chunkIndex } };
  }

  // A chunk the caller is SENDING AGAIN (a retried request, a resumed loop).
  // `applyChunk` already refuses to write it twice, but the running tally is a
  // separate fold and would count it twice — reporting 7 000 rows written for a
  // 5 000-row load while the table holds the right 5 000. Measured, not
  // theorised: this is what a probe of the real path produced.
  const replayed = chunkAlreadyApplied(chunk);
  const outcome = await applyChunk({ operation, chunk, items: args.rows });
  if (!replayed) {
    await recordDirectProgress(operation.id, chunk.chunkIndex, outcome);
  }
  return {
    status: "ok",
    data: {
      applied: chunk.chunkIndex,
      ids: outcome.ids ?? [],
      okCount: outcome.succeeded,
      errors: outcome.errors,
    },
  };
};

/** Fold one directly-applied chunk into the operation's running tally. */
const recordDirectProgress = async (
  operationId: string,
  chunkIndex: number,
  outcome: {
    succeeded: number;
    failed: number;
    errors: { index: number; error: string }[];
  },
): Promise<void> => {
  const current = await findBulkOperation(operationId);
  if (current === undefined) return;
  await updateBulkOperationProgress(
    operationId,
    foldChunkProgress(
      current.progress ?? emptyProgress(),
      outcome,
      chunkIndex * current.chunkSize,
    ),
  );
};

const importCommitArgs = z.object({ operationId: z.uuid() });

/** Close the upload: finalize a direct load, or open the single approval card. */
const importCommit = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { operationId } = importCommitArgs.parse(rawArgs);
  const operation = await findTeamOperation(ctx, operationId);
  if (operation === null) return unknownOperation(operationId);
  return commitBulkOperation({ operation });
};

/**
 * An operation of THIS conversation. Scoping on the conversation, not just the
 * team, is what stops one turn from committing or extending a load opened by
 * another — the operation id travels through agent-written code.
 */
const findTeamOperation = async (
  ctx: ExecContext,
  operationId: string,
): Promise<BulkOperation | null> => {
  const row = await findBulkOperation(operationId);
  if (!row) return null;
  if (row.teamId !== ctx.teamId || row.conversationId !== ctx.conversationId) {
    return null;
  }
  return row;
};

const unknownOperation = (id: string): SandboxExecResponse => ({
  status: "error",
  message: `No bulk operation '${id}' in this conversation. Re-run the load from the start.`,
});

const queryArgs = z.object({
  collectionKey: z.string().min(1).max(60),
  filters: z.record(z.string(), z.unknown()).optional(),
  page: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

const queryRecords = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { collectionKey, filters, page, limit } = queryArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, collectionKey);
  if (collectionId === null) return unknownType(collectionKey);

  const records = await queryCollectionRecords({
    teamId: ctx.teamId,
    collectionId,
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
  // Explicit column key; defaults to a slug of the label. Set it on any field
  // a `formula` in the same call names in its expression.
  key: z.string().max(60).optional(),
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
  description: z.string().min(1).max(COLLECTION_LIMITS.MAX_DESCRIPTION_CHARS),
  icon: z.string().nullish(),
  // Cross-team audience. Omit = internal (owning team only).
  sharing: audienceSchema.optional(),
  fields: z.array(fieldInputSchema).optional(),
});

/**
 * Create a collection (provisions its typed table). Pass `fields` to build the
 * whole schema atomically — the migration entry point when splitting one type
 * into several. Colors are auto-assigned server-side.
 */
const createType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = createTypeArgs.parse(rawArgs);
  if (args.fields && args.fields.length > 0) {
    const created = await createCollectionWithFields({
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
        key: f.key,
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
  const type = await createCollection({
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
  collectionKey: z.string().min(1).max(60),
  label: z.string().optional(),
  labelPlural: z.string().nullish(),
  description: z
    .string()
    .max(COLLECTION_LIMITS.MAX_DESCRIPTION_CHARS)
    .nullish(),
  icon: z.string().nullish(),
  enabled: z.boolean().optional(),
  // Change the cross-team audience (owner team only).
  sharing: audienceSchema.optional(),
  addFields: z.array(fieldInputSchema).optional(),
});

/**
 * Update a collection in one call: patch its presentation/lifecycle metadata
 * AND/OR add several new fields at once (`addFields`). Editing or removing
 * existing fields is `change_field`; this op only grows the schema.
 */
const updateType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = updateTypeArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, args.collectionKey);
  if (collectionId === null) return unknownType(args.collectionKey);

  const hasMetadata =
    args.label !== undefined ||
    args.labelPlural !== undefined ||
    args.description !== undefined ||
    args.icon !== undefined ||
    args.enabled !== undefined;
  if (hasMetadata || args.sharing) {
    await updateCollection({
      id: collectionId,
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
      collectionId,
      label: f.label,
      type: f.type,
      config: f.config,
      description: f.description ?? null,
      isTitle: f.isTitle,
      actor: execActor(ctx),
    });
    addedFields.push({ key: field.key, type: field.type });
  }

  return { status: "ok", data: { key: args.collectionKey, addedFields } };
};

const addFieldArgs = z.object({
  collectionKey: z.string().min(1).max(60),
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
  const collectionId = await resolveTeamType(ctx, args.collectionKey);
  if (collectionId === null) return unknownType(args.collectionKey);

  const field = await createFieldDefinition({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    collectionId,
    label: args.label,
    type: args.type,
    config: args.config,
    description: args.description ?? null,
    actor: execActor(ctx),
  });
  return { status: "ok", data: { key: field.key, type: field.type } };
};

const changeFieldArgs = z.object({
  collectionKey: z.string().min(1).max(60),
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
  const collectionId = await resolveTeamType(ctx, args.collectionKey);
  if (collectionId === null) return unknownType(args.collectionKey);

  const fields = await getFieldDefinitionsForTeam({
    teamId: ctx.teamId,
    collectionId,
    includeDisabled: true,
  });
  const field = fields.find((f) => f.key === args.fieldKey);
  if (!field) {
    return {
      status: "error",
      message: `No field '${args.fieldKey}' on type '${args.collectionKey}'.`,
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

const deleteTypeArgs = z.object({ collectionKey: z.string().min(1).max(60) });

/** Drop a type and every record in it. The last step of a merge/split. */
const deleteType = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { collectionKey } = deleteTypeArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, collectionKey);
  if (collectionId === null) return unknownType(collectionKey);

  const result = await deleteCollection({
    id: collectionId,
    actor: execActor(ctx),
  });
  return { status: "ok", data: result };
};

// ── Sync sources (a collection an app fills) ──────────────────────────
//
// The Python mirror of the `manageSync` tool, for the same reason the record
// ops have one: a migration that also wires a source is one script, and a tool
// round-trip per step would put the whole mapping back in the agent's context.
//
// Preview and refresh are reads; create/update/delete are refused in a run by
// the guard at the top of this file.

const syncPreviewArgs = z.object({
  connectionId: z.uuid(),
  operation: z.string().min(1).max(120),
  args: syncArgsSchema.default({}),
  resultPath: z.string().max(200).optional(),
  sampleRecordId: z.uuid().optional(),
  // Try the match before creating anything: all three together, or none.
  collectionKey: z.string().min(1).max(60).optional(),
  matchFieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  externalIdPath: z.string().max(200).optional(),
});

const syncPreview = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = syncPreviewArgs.parse(rawArgs);
  const collectionId =
    args.collectionKey === undefined
      ? null
      : await resolveTeamType(ctx, args.collectionKey);
  if (args.collectionKey !== undefined && collectionId === null) {
    return unknownType(args.collectionKey);
  }
  const preview = await previewSyncSource({
    teamId: ctx.teamId,
    userId: ctx.userId,
    connectionId: args.connectionId,
    operation: args.operation,
    args: args.args,
    ...(args.resultPath === undefined ? {} : { resultPath: args.resultPath }),
    ...(args.sampleRecordId === undefined
      ? {}
      : { sampleRecordId: args.sampleRecordId }),
    ...(collectionId === null ? {} : { collectionId }),
    ...(args.matchFieldKey === undefined
      ? {}
      : { matchFieldKey: args.matchFieldKey }),
    ...(args.externalIdPath === undefined
      ? {}
      : { externalIdPath: args.externalIdPath }),
  });
  return { status: "ok", data: preview };
};

const syncFieldArgs = z.object({
  path: z.string().min(1).max(200),
  label: z.string().min(1).max(120),
  fieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  type: fieldDefinitionTypeSchema.default("text"),
  isTitle: z.boolean().optional(),
});

const syncCreateArgs = z.object({
  collectionKey: z.string().min(1).max(60),
  connectionId: z.uuid(),
  operation: z.string().min(1).max(120),
  kind: syncKindSchema.default("table"),
  fields: z.array(syncFieldArgs).min(1).max(SYNC_LIMITS.maxMappedFields),
  args: syncArgsSchema.default({}),
  resultPath: z.string().max(200).optional(),
  externalIdPath: z.string().max(200).optional(),
  matchFieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .max(60)
    .optional(),
  schedule: syncScheduleSchema.default({ mode: "manual" }),
  orphanPolicy: syncOrphanPolicySchema.default("keep"),
  rowCap: z.number().int().min(1).max(SYNC_LIMITS.maxRowCap).optional(),
});

const syncCreate = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const args = syncCreateArgs.parse(rawArgs);
  const collectionId = await resolveTeamType(ctx, args.collectionKey);
  if (collectionId === null) return unknownType(args.collectionKey);

  const source = await createSyncSource({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    collectionId,
    kind: args.kind,
    connectionId: args.connectionId,
    // Stamped from the connection by the service — see
    // `assertConnectionUsable`.
    providerKey: "",
    operation: args.operation,
    args: args.args,
    ...(args.matchFieldKey === undefined
      ? {}
      : { matchFieldKey: args.matchFieldKey }),
    ...(args.resultPath === undefined ? {} : { resultPath: args.resultPath }),
    ...(args.externalIdPath === undefined
      ? {}
      : { externalIdPath: args.externalIdPath }),
    fields: args.fields,
    schedule: args.schedule,
    orphanPolicy: args.orphanPolicy,
    ...(args.rowCap === undefined ? {} : { rowCap: args.rowCap }),
  });
  return { status: "ok", data: { sourceId: source.id, collectionId } };
};

const syncUpdateArgs = z.object({
  sourceId: z.uuid(),
  args: syncArgsSchema.optional(),
  schedule: syncScheduleSchema.optional(),
  orphanPolicy: syncOrphanPolicySchema.optional(),
  rowCap: z.number().int().min(1).max(SYNC_LIMITS.maxRowCap).optional(),
  fields: z.array(syncFieldArgs).max(SYNC_LIMITS.maxMappedFields).optional(),
});

const syncUpdate = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { sourceId, ...patch } = syncUpdateArgs.parse(rawArgs);
  const source = await updateSyncSource({
    id: sourceId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    patch,
  });
  return { status: "ok", data: { sourceId: source.id } };
};

const syncDeleteArgs = z.object({ sourceId: z.uuid() });

const syncDelete = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { sourceId } = syncDeleteArgs.parse(rawArgs);
  await deleteSyncSource({
    id: sourceId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
  });
  return { status: "ok", data: { sourceId, deleted: true } };
};

const syncConfirmArgs = z.object({ sourceId: z.uuid() });

const syncConfirmFullResync = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const { sourceId } = syncConfirmArgs.parse(rawArgs);
  const { enqueued } = await confirmFullResync({
    sourceId,
    teamId: ctx.teamId,
    ...(ctx.userId == null ? {} : { userId: ctx.userId }),
  });
  return { status: "ok", data: { sourceId, enqueued } };
};

const syncSelectorArgs = z.object({
  collectionKey: z.string().min(1).max(60).optional(),
  sourceId: z.uuid().optional(),
});

/** The sources this call is about: one by id, a collection's, or the team's. */
const selectSources = async (
  ctx: ExecContext,
  selector: z.infer<typeof syncSelectorArgs>,
) => {
  if (selector.sourceId !== undefined) {
    const all = await listSyncSources({ teamId: ctx.teamId });
    return all.filter((source) => source.id === selector.sourceId);
  }
  const collectionId =
    selector.collectionKey === undefined
      ? null
      : await resolveTeamType(ctx, selector.collectionKey);
  return listSyncSources({
    teamId: ctx.teamId,
    ...(collectionId === null ? {} : { collectionId }),
  });
};

const syncRefresh = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const selector = syncSelectorArgs.parse(rawArgs);
  const runnable = (await selectSources(ctx, selector)).filter(
    (source) => source.enabled,
  );
  if (runnable.length === 0) {
    return {
      status: "error",
      message:
        "NO_SYNC_SOURCE: nothing here is filled by an app, or its source is turned off. Check collections.sync.list() first.",
    };
  }
  const queued = await Promise.all(
    runnable.map(async (source) => ({
      sourceId: source.id,
      operation: source.operation,
      ...(await requestSyncRefresh({
        sourceId: source.id,
        teamId: ctx.teamId,
        trigger: "manual",
        ...(ctx.userId == null ? {} : { userId: ctx.userId }),
      })),
    })),
  );
  return { status: "ok", data: { queued } };
};

const syncList = async (
  ctx: ExecContext,
  rawArgs: Record<string, unknown>,
): Promise<SandboxExecResponse> => {
  const sources = await selectSources(ctx, syncSelectorArgs.parse(rawArgs));
  return {
    status: "ok",
    data: {
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        operation: source.operation,
        schedule: source.schedule,
        incremental: source.incremental,
        lastSuccessAt: source.lastSuccessAt,
        nextRunAt: source.nextRunAt,
        health: source.health,
        orphanPolicy: source.orphanPolicy,
        enabled: source.enabled,
      })),
    },
  };
};

// ── Helpers ───────────────────────────────────────────────────────────

const resolveTeamType = (
  ctx: ExecContext,
  key: string,
): Promise<string | null> =>
  resolveCollectionId({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    key,
  });

const unknownType = (key: string): SandboxExecResponse => ({
  status: "error",
  message: `No collection '${key}' for this team. List types first.`,
});

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
