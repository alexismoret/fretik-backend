import { requireDriveAction } from "../../authz/drive";
import { driveVisibility } from "../../authz/drive-sql";
import { loadPrincipal } from "../../authz/load-principal";
import type { UserPrincipal } from "../../authz/principal";
import { confineToProject, isTeamAgent } from "../../authz/project-agent";
import { forbidden, throwHttpError } from "../../lib/errors";
import { recordSharingSchema } from "../../schemas/collection-sharing";
import {
  fieldConfigSchema,
  fieldDefinitionTypeSchema,
} from "../../schemas/field-definitions";
import { recordRelationInputSchema } from "../../schemas/ontology";
import { promoteSandboxFileToDrive } from "../chat-files/promote-sandbox-file-to-drive";
import { promoteChatFilesToDrive } from "../chat-files/promote-to-drive";
import { createCollectionRecord } from "../collection-records/create";
import { deleteCollectionRecord } from "../collection-records/delete";
import { setRecordStatus } from "../collection-records/set-status";
import { setRecordData } from "../collection-records/update";
import { requireRecordAudienceAllowed } from "../collection-sharing/audience-policy";
import {
  assertCanDeleteRecords,
  assertCanManageType,
  assertCanShareRecord,
  assertCanWriteLink,
  assertCanWriteRecord,
  assertCanWriteType,
} from "../collection-sharing/write-access";
import { confirmFullResync } from "../collection-sync/confirm-full-resync";
import { deleteCollection } from "../collections/delete";
import { saveAuthoredContent } from "../documents/authored/content";
import { createAuthoredDocument } from "../documents/authored/create";
import { updateDocument } from "../documents/update";
import { restoreDocumentVersion } from "../documents/versions/restore";
import type { EventActor } from "../domain-events/emit";
import { deleteFieldDefinition } from "../field-definitions/delete";
import { updateFieldDefinition } from "../field-definitions/update";
import { createFolder } from "../folders/create";
import { deleteFolders } from "../folders/delete";
import { updateFolder } from "../folders/update";
import { createLink } from "../links/create";
import { invalidateLink } from "../links/invalidate";
import { installSkillFromCatalog } from "../skills/install-from-catalog";

/**
 * Grant-time application for the `tool_call` approval kind. Each entry mirrors
 * ONE builtin write tool's effect by calling the SAME shared services the
 * tool's direct path uses — so a grant runs in the API process (which never
 * imports `@fretik/ai`). The AI tool does all validation + id resolution at
 * PROPOSAL time and stores already-resolved args; these functions only apply
 * them. Keep this in sync with each tool's proposal payload (the
 * `withToolCallGate` call sites in `@fretik/ai`).
 *
 * The config tools are here only for their DESTRUCTIVE actions
 * (`manageCollection.delete`, `manageField.delete` / `changeType`,
 * `manageSync.confirmFullResync`) — the ones that drop a table or a column and
 * take the data with them, or let a run apply an orphan policy to rows the
 * floor refused to touch. Their harmless actions stay `auto` and never reach
 * this map; `manageWorkflow` and `managePage` have no entry at all and remain
 * blockable-only.
 */

/** Tenant context an apply fn needs — sourced from the approval row. */
export interface ToolCallApplyContext {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
  /**
   * The project the chat works in, as it is when the grant is applied: what
   * the write creates at a root lands at the project's.
   */
  projectId: string | null;
}

/** Where something created at a root lands: the chat's project, if any. */
const rootProjectOf = (
  ctx: ToolCallApplyContext,
  folderId: string | null,
): string | null => (folderId === null ? ctx.projectId : null);

export type ToolCallApplyFn = (
  ctx: ToolCallApplyContext,
  args: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// ---- typed arg accessors (args were validated at proposal; re-narrow here) --

const str = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`Missing string arg "${key}"`);
  return v;
};

const strOrNull = (
  args: Record<string, unknown>,
  key: string,
): string | null => {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new Error(`Arg "${key}" must be a string`);
  return v;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const recordArg = (
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const v = args[key];
  if (!isRecord(v)) throw new Error(`Arg "${key}" must be an object`);
  return v;
};

const agentActor = (ctx: ToolCallApplyContext): EventActor => ({
  actorType: "agent",
  actorUserId: ctx.userId,
  conversationId: ctx.conversationId,
});

/**
 * The person the approved write acts for, as the access engine sees them NOW.
 * The tool asked the same questions before the card opened; a grant can come
 * hours later, after the person was made a viewer or left, so each apply asks
 * them again (the same rules as the tool's, `authz/drive.ts` and
 * `collection-sharing/write-access.ts`). The team's agent, in a project's
 * run, works for the project alone, as it did when it asked
 * (`confineToProject`).
 */
const principalOf = async (
  ctx: ToolCallApplyContext,
): Promise<UserPrincipal> => {
  const principal = await loadPrincipal({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  if (!principal) {
    return throwHttpError(
      403,
      forbidden("The person this was for is no longer in the organization."),
    );
  }
  return ctx.projectId !== null && isTeamAgent(principal)
    ? confineToProject(principal, ctx.projectId)
    : principal;
};

// ---- manageLink -----------------------------------------------------------

const applyManageLink: ToolCallApplyFn = async (ctx, args) => {
  const actor = agentActor(ctx);
  const action = str(args, "action");
  const scope = {
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  };
  if (action === "unlink") {
    await assertCanWriteLink({ linkId: str(args, "linkId"), ...scope });
    const link = await invalidateLink({ id: str(args, "linkId"), actor });
    return { ok: true, unlinked: link.id };
  }
  await assertCanWriteRecord({
    recordId: str(args, "fromRecordId"),
    ...scope,
  });
  const link = await createLink({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    drive: await driveVisibility(await principalOf(ctx), ctx.teamId),
    linkTypeId: str(args, "linkTypeId"),
    fromRecordId: str(args, "fromRecordId"),
    toRecordId: str(args, "toRecordId"),
    actor,
  });
  return { ok: true, linkId: link.id };
};

// ---- manageDrive ----------------------------------------------------------

const applyManageDrive: ToolCallApplyFn = async (ctx, args) => {
  const actor = agentActor(ctx);
  const action = str(args, "action");
  const principal = await principalOf(ctx);

  if (action === "createFolder") {
    const parentFolderId = strOrNull(args, "parentFolderId");
    const projectId = rootProjectOf(ctx, parentFolderId);
    await requireDriveAction(principal, {
      kind: "createFolder",
      teamId: ctx.teamId,
      parentFolderId,
      projectId,
    });
    const description = strOrNull(args, "description");
    const folder = await createFolder({
      name: str(args, "name"),
      parentFolderId,
      projectId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      actor,
      ...(description
        ? { description: { text: description, source: "agent" } }
        : {}),
    });
    return { ok: true, folder: { id: folder.id, name: folder.name } };
  }
  if (action === "describeFolder") {
    const folderId = str(args, "folderId");
    await requireDriveAction(principal, { kind: "describeFolder", folderId });
    // `""` clears it, handing the folder back to the nightly generator.
    const folder = await updateFolder({
      id: folderId,
      teamId: ctx.teamId,
      updates: { description: strOrNull(args, "description") ?? "" },
      actor,
      descriptionSource: "agent",
    });
    return {
      ok: true,
      folder: {
        id: folder.id,
        name: folder.name,
        description: folder.description,
      },
    };
  }
  if (action === "renameFolder") {
    await requireDriveAction(principal, {
      kind: "renameFolder",
      folderId: str(args, "folderId"),
    });
    const folder = await updateFolder({
      id: str(args, "folderId"),
      teamId: ctx.teamId,
      updates: { name: str(args, "name") },
      actor,
    });
    return { ok: true, folder: { id: folder.id, name: folder.name } };
  }
  if (action === "moveFolder") {
    await requireDriveAction(principal, {
      kind: "moveFolder",
      folderId: str(args, "folderId"),
      parentFolderId: strOrNull(args, "parentFolderId"),
    });
    const folder = await updateFolder({
      id: str(args, "folderId"),
      teamId: ctx.teamId,
      updates: { parentFolderId: strOrNull(args, "parentFolderId") },
      actor,
    });
    return { ok: true, folder: { id: folder.id, name: folder.name } };
  }
  if (action === "deleteFolder") {
    const folderId = str(args, "folderId");
    await requireDriveAction(principal, { kind: "deleteFolder", folderId });
    await deleteFolders({ ids: [folderId], teamId: ctx.teamId, actor });
    return { ok: true, deleted: true, folderId };
  }
  if (action === "renameDocument") {
    const documentId = str(args, "documentId");
    await requireDriveAction(principal, { kind: "renameDocument", documentId });
    const renamed = await updateDocument({
      id: documentId,
      teamId: ctx.teamId,
      organizationId: ctx.organizationId,
      updates: { originalFilename: str(args, "name") },
    });
    return {
      ok: true,
      document: {
        id: renamed?.id ?? documentId,
        name: renamed?.originalFilename,
      },
    };
  }
  // moveDocument — the fall-through, so every action ABOVE must be handled
  // explicitly: an unmatched one would silently move the document to the root.
  const documentId = str(args, "documentId");
  await requireDriveAction(principal, {
    kind: "moveDocument",
    documentId,
    folderId: strOrNull(args, "parentFolderId"),
  });
  const doc = await updateDocument({
    id: documentId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    updates: { folderId: strOrNull(args, "parentFolderId") },
  });
  return {
    ok: true,
    document: { id: doc?.id ?? documentId },
  };
};

// ---- manageDocument (authoring + rollback) --------------------------------

const applyManageDocument: ToolCallApplyFn = async (ctx, args) => {
  const action = str(args, "action");
  const actorContext = {
    actor: "agent" as const,
    userId: ctx.userId,
    conversationId: ctx.conversationId,
  };

  const principal = await principalOf(ctx);

  if (action === "create") {
    const folderId = strOrNull(args, "folderId");
    const projectId = rootProjectOf(ctx, folderId);
    await requireDriveAction(principal, {
      kind: "addDocument",
      teamId: ctx.teamId,
      folderId,
      projectId,
    });
    const document = await createAuthoredDocument({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      title: str(args, "title"),
      content: strOrNull(args, "content") ?? "",
      folderId,
      projectId,
      actorContext,
      eventActor: {
        actorType: "agent",
        actorUserId: ctx.userId,
        conversationId: ctx.conversationId,
      },
    });
    return {
      ok: true,
      documentId: document.id,
      title: document.originalFilename,
      versionNumber: 1,
    };
  }

  // Restoring or writing: both change what the document says.
  await requireDriveAction(principal, {
    kind: "editDocument",
    documentId: str(args, "documentId"),
  });

  if (action === "restore") {
    const result = await restoreDocumentVersion({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      documentId: str(args, "documentId"),
      versionId: str(args, "versionId"),
      actorContext,
    });
    return {
      ok: true,
      documentId: result.document.id,
      versionNumber: result.version.versionNumber,
    };
  }

  // update. The edits were already applied when the proposal was built, so the
  // stored `content` is the finished text — the grant only writes it. The
  // revision still travels: the document may have moved between proposal and
  // approval, and overwriting a newer version silently is exactly what the
  // read-before-write contract exists to prevent.
  const result = await saveAuthoredContent({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    documentId: str(args, "documentId"),
    content: strOrNull(args, "content") ?? "",
    actorContext,
    expectedFileHash: str(args, "revision"),
  });
  return {
    ok: true,
    documentId: result.document.id,
    versionNumber: result.version.versionNumber,
    unchanged: result.unchanged,
  };
};

// ---- uploadToDrive --------------------------------------------------------

/**
 * Read a list-shaped arg that may still arrive in its pre-batch singular
 * form.
 *
 * An approval row outlives the deploy that created it: a grant clicked after
 * `uploadToDrive` became batch may carry `path` / `fileId` from before it,
 * and applying that grant as "no files" would silently save nothing while
 * reporting success.
 *
 * Exported for its test — this compatibility is invisible until a deploy
 * lands on a queue of pending approvals, which is exactly when nobody is
 * looking.
 */
export const strListOrSingle = (
  args: Record<string, unknown>,
  listKey: string,
  singleKey: string,
): string[] => {
  const list = args[listKey];
  if (Array.isArray(list)) {
    return list.filter((value): value is string => typeof value === "string");
  }
  const single = strOrNull(args, singleKey);
  return single === null ? [] : [single];
};

const applyUploadToDrive: ToolCallApplyFn = async (ctx, args) => {
  // Two sources, both able to appear in one grant: `paths` are files the agent
  // produced in its workspace, `fileIds` attachments the user brought. Same
  // split as the tool's own `execute`, and the same per-file outcome — a grant
  // covering eight files must not lose seven of them to the first bad one.
  const paths = strListOrSingle(args, "paths", "path");
  const fileIds = strListOrSingle(args, "fileIds", "fileId");
  const folderId = strOrNull(args, "folderId");
  const replaceDocumentId = strOrNull(args, "replaceDocumentId");

  const projectId = rootProjectOf(ctx, folderId);
  const principal = await principalOf(ctx);
  await requireDriveAction(principal, {
    kind: "addDocument",
    teamId: ctx.teamId,
    folderId,
    projectId,
  });
  if (replaceDocumentId !== null) {
    await requireDriveAction(principal, {
      kind: "editDocument",
      documentId: replaceDocumentId,
    });
  }

  const saved: Record<string, unknown>[] = [];
  const failed: { file: string; reason: string }[] = [];

  for (const path of paths) {
    try {
      const result = await promoteSandboxFileToDrive({
        conversationId: ctx.conversationId,
        path,
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        principal,
        folderId,
        projectId,
        ...(replaceDocumentId !== null ? { replaceDocumentId } : {}),
        actorContext: {
          actor: "agent",
          userId: ctx.userId,
          conversationId: ctx.conversationId,
        },
      });
      saved.push({
        file: path,
        documentId: result.documentId,
        filename: result.filename,
        versionNumber: result.versionNumber,
        created: result.created,
      });
    } catch (error) {
      failed.push({
        file: path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (fileIds.length > 0) {
    const { promoted, failed: promotionFailures } =
      await promoteChatFilesToDrive({
        fileIds,
        conversationId: ctx.conversationId,
        organizationId: ctx.organizationId,
        teamId: ctx.teamId,
        userId: ctx.userId,
        folderId,
        projectId,
      });
    for (const ok of promoted) {
      saved.push({
        file: ok.fileId,
        documentId: ok.documentId,
        versionNumber: 1,
        created: true,
      });
    }
    for (const failure of promotionFailures) {
      failed.push({ file: failure.fileId, reason: failure.reason });
    }
  }

  // Nothing landed at all — the grant did not do what the card promised, so
  // it fails rather than reporting an empty success.
  if (saved.length === 0) {
    throw new Error(failed[0]?.reason ?? "Upload failed: no files to save.");
  }

  return { ok: failed.length === 0, saved, failed, status: "processing" };
};

// ---- manageRecord (single-record create / update / delete / setStatus) -----

const serializeRecord = (r: {
  id: string;
  label: string;
  status: string;
}): Record<string, unknown> => ({ id: r.id, label: r.label, status: r.status });

const applyManageRecord: ToolCallApplyFn = async (ctx, args) => {
  const actor = agentActor(ctx);
  const action = str(args, "action");
  const scope = {
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  };

  const sharing =
    args.sharing === undefined
      ? undefined
      : recordSharingSchema.parse(args.sharing);

  if (action === "create") {
    await assertCanWriteType({
      collectionId: str(args, "collectionId"),
      ...scope,
    });
    await requireRecordAudienceAllowed({ ...scope, sharing });
    const record = await createCollectionRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      collectionId: str(args, "collectionId"),
      data: recordArg(args, "data"),
      labelOverride: strOrNull(args, "labelOverride"),
      relations:
        args.relations === undefined
          ? undefined
          : recordRelationInputSchema.array().parse(args.relations),
      sharing,
      actor,
    });
    return { ok: true, record: serializeRecord(record) };
  }

  // Every other action writes one existing record.
  const recordId = str(args, "recordId");
  await assertCanWriteRecord({ recordId, ...scope });

  if (action === "update") {
    if (sharing !== undefined) {
      await assertCanShareRecord({ recordId, ...scope });
      await requireRecordAudienceAllowed({ ...scope, sharing });
    }
    const hasData = args.data !== undefined;
    const record = await setRecordData({
      id: recordId,
      data: hasData ? recordArg(args, "data") : undefined,
      merge: true,
      labelOverride: strOrNull(args, "labelOverride"),
      sharing,
      callerTeamId: ctx.teamId,
      actor,
    });
    return { ok: true, record: serializeRecord(record) };
  }

  if (action === "delete") {
    await assertCanDeleteRecords({ recordIds: [recordId], ...scope });
    const result = await deleteCollectionRecord({
      id: recordId,
      actor,
    });
    return { ok: true, ...result };
  }

  // setStatus
  const status = str(args, "status");
  if (status !== "confirmed" && status !== "rejected") {
    throw new Error(`manageRecord setStatus: invalid status ${status}`);
  }
  const record = await setRecordStatus({
    id: str(args, "recordId"),
    status,
    actor,
  });
  return { ok: true, record: serializeRecord(record) };
};

// ---- installSkill ---------------------------------------------------------

const applyInstallSkill: ToolCallApplyFn = async (ctx, args) => {
  const [owner, repo, ...slugParts] = str(args, "id").split("/");
  const slug = slugParts.join("/");
  if (owner === undefined || repo === undefined || slug === "") {
    throw new Error(
      `installSkill: invalid skill id (expected owner/repo/slug)`,
    );
  }
  const skill = await installSkillFromCatalog({
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    owner,
    repo,
    slug,
    actor: agentActor(ctx),
  });
  return { ok: true, name: skill.name };
};

// ---- manageCollection / manageField ---------------------------------------
//
// Only the destructive actions are gated, so only those apply here — anything
// else reaching this map is a proposal/apply mismatch and throws rather than
// guessing. Both ask again: a proposal can sit pending for a while, and a
// share revoked or a role lowered in between must not be honoured at grant
// time.

const applyManageCollection: ToolCallApplyFn = async (ctx, args) => {
  const action = str(args, "action");
  if (action !== "delete") {
    throw new Error(`manageCollection "${action}" is not approval-gated`);
  }
  const collectionId = str(args, "collectionId");
  // The type is its owner's to delete, with full access to the team's
  // content: asked again, as the proposal may have waited.
  await assertCanManageType({
    collectionId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    change: "delete",
  });
  const result = await deleteCollection({
    id: collectionId,
    actor: agentActor(ctx),
  });
  return { ok: true, ...result };
};

const applyManageField: ToolCallApplyFn = async (ctx, args) => {
  const action = str(args, "action");
  const collectionId = str(args, "collectionId");
  const fieldId = str(args, "fieldId");
  await assertCanWriteType({
    collectionId,
    teamId: ctx.teamId,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
  });
  const actor = agentActor(ctx);

  if (action === "delete") {
    const result = await deleteFieldDefinition({
      id: fieldId,
      cascade: args.cascade === true,
      actor,
    });
    return { ok: true, ...result };
  }
  if (action === "changeType") {
    const updated = await updateFieldDefinition({
      id: fieldId,
      cascade: true,
      patch: {
        type: fieldDefinitionTypeSchema.parse(args.type),
        config:
          args.config === undefined
            ? undefined
            : fieldConfigSchema.parse(args.config),
      },
      actor,
    });
    return { ok: true, field: { id: updated.id, key: updated.key } };
  }
  throw new Error(`manageField "${action}" is not approval-gated`);
};

// ---- manageSync ------------------------------------------------------------
//
// One gated action: the confirmation that lets a run apply the orphan policy
// the floor refused. Everything else the tool does is reversible by doing it
// again and never reaches this map.
//
// No `assertCanWriteType` here, unlike its neighbours: `confirmFullResync`
// scopes by `teamId` itself and answers 404 for another team's source, so the
// grant cannot reach across a tenancy the proposal did not already hold. The
// service also re-checks that a resync is still PENDING — a grant that sat
// while somebody refreshed the source successfully applies nothing rather than
// arming the next run's floor against a difference nobody has seen.

const applyManageSync: ToolCallApplyFn = async (ctx, args) => {
  const action = str(args, "action");
  if (action !== "confirmFullResync") {
    throw new Error(`manageSync "${action}" is not approval-gated`);
  }
  const result = await confirmFullResync({
    sourceId: str(args, "sourceId"),
    teamId: ctx.teamId,
    userId: ctx.userId,
  });
  return { ok: true, ...result };
};

/** The apply registry. A `tool_call` payload's `toolName` MUST have an entry. */
export const TOOL_CALL_APPLY: Record<string, ToolCallApplyFn> = {
  manageLink: applyManageLink,
  manageDrive: applyManageDrive,
  uploadToDrive: applyUploadToDrive,
  manageDocument: applyManageDocument,
  manageRecord: applyManageRecord,
  installSkill: applyInstallSkill,
  manageCollection: applyManageCollection,
  manageField: applyManageField,
  manageSync: applyManageSync,
};
