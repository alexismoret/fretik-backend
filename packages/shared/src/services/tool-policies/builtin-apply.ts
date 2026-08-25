import { recordSharingSchema } from "../../schemas/collection-sharing";
import { recordRelationInputSchema } from "../../schemas/ontology";
import { promoteSandboxFileToDrive } from "../chat-files/promote-sandbox-file-to-drive";
import { promoteChatFilesToDrive } from "../chat-files/promote-to-drive";
import { createCollectionRecord } from "../collection-records/create";
import { deleteCollectionRecord } from "../collection-records/delete";
import { setRecordStatus } from "../collection-records/set-status";
import { setRecordData } from "../collection-records/update";
import { saveAuthoredContent } from "../documents/authored/content";
import { createAuthoredDocument } from "../documents/authored/create";
import { updateDocument } from "../documents/update";
import { restoreDocumentVersion } from "../documents/versions/restore";
import type { EventActor } from "../domain-events/emit";
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
 * Only the data/drive write tools are here. Schema/automation config tools
 * (`manageCollection`, `manageField`, `manageWorkflow`) are blockable-only (no
 * approval level) so they never reach this map.
 */

/** Tenant context an apply fn needs — sourced from the approval row. */
export interface ToolCallApplyContext {
  organizationId: string;
  teamId: string;
  userId: string;
  conversationId: string;
}

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

// ---- manageLink -----------------------------------------------------------

const applyManageLink: ToolCallApplyFn = async (ctx, args) => {
  const actor = agentActor(ctx);
  const action = str(args, "action");
  if (action === "unlink") {
    const link = await invalidateLink({ id: str(args, "linkId"), actor });
    return { ok: true, unlinked: link.id };
  }
  const link = await createLink({
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
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

  if (action === "createFolder") {
    const folder = await createFolder({
      name: str(args, "name"),
      parentFolderId: strOrNull(args, "parentFolderId"),
      teamId: ctx.teamId,
      userId: ctx.userId,
      actor,
    });
    return { ok: true, folder: { id: folder.id, name: folder.name } };
  }
  if (action === "renameFolder") {
    const folder = await updateFolder({
      id: str(args, "folderId"),
      teamId: ctx.teamId,
      updates: { name: str(args, "name") },
      actor,
    });
    return { ok: true, folder: { id: folder.id, name: folder.name } };
  }
  if (action === "moveFolder") {
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
    await deleteFolders({ ids: [folderId], teamId: ctx.teamId, actor });
    return { ok: true, deleted: true, folderId };
  }
  if (action === "renameDocument") {
    const documentId = str(args, "documentId");
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

  if (action === "create") {
    const document = await createAuthoredDocument({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      title: str(args, "title"),
      content: strOrNull(args, "content") ?? "",
      folderId: strOrNull(args, "folderId"),
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

const applyUploadToDrive: ToolCallApplyFn = async (ctx, args) => {
  // Two proposal shapes, one per source: `path` is a file the agent produced in
  // its workspace, `fileId` an attachment the user brought. Same split as the
  // tool's own `execute`.
  const path = strOrNull(args, "path");
  if (path !== null) {
    const replaceDocumentId = strOrNull(args, "replaceDocumentId");
    const result = await promoteSandboxFileToDrive({
      conversationId: ctx.conversationId,
      path,
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      folderId: strOrNull(args, "folderId"),
      ...(replaceDocumentId !== null ? { replaceDocumentId } : {}),
      actorContext: {
        actor: "agent",
        userId: ctx.userId,
        conversationId: ctx.conversationId,
      },
    });
    return {
      ok: true,
      documentId: result.documentId,
      versionNumber: result.versionNumber,
      created: result.created,
      status: "processing",
    };
  }

  const fileId = str(args, "fileId");
  const { promoted, failed } = await promoteChatFilesToDrive({
    fileIds: [fileId],
    conversationId: ctx.conversationId,
    organizationId: ctx.organizationId,
    teamId: ctx.teamId,
    userId: ctx.userId,
    folderId: strOrNull(args, "folderId"),
  });
  const ok = promoted[0];
  if (ok === undefined) {
    throw new Error(failed[0]?.reason ?? "Upload failed.");
  }
  return { ok: true, documentId: ok.documentId, status: "processing" };
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

  if (action === "create") {
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
      sharing:
        args.sharing === undefined
          ? undefined
          : recordSharingSchema.parse(args.sharing),
      actor,
    });
    return { ok: true, record: serializeRecord(record) };
  }

  if (action === "update") {
    const hasData = args.data !== undefined;
    const record = await setRecordData({
      id: str(args, "recordId"),
      data: hasData ? recordArg(args, "data") : undefined,
      merge: true,
      labelOverride: strOrNull(args, "labelOverride"),
      sharing:
        args.sharing === undefined
          ? undefined
          : recordSharingSchema.parse(args.sharing),
      callerTeamId: ctx.teamId,
      actor,
    });
    return { ok: true, record: serializeRecord(record) };
  }

  if (action === "delete") {
    const result = await deleteCollectionRecord({
      id: str(args, "recordId"),
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

/** The apply registry. A `tool_call` payload's `toolName` MUST have an entry. */
export const TOOL_CALL_APPLY: Record<string, ToolCallApplyFn> = {
  manageLink: applyManageLink,
  manageDrive: applyManageDrive,
  uploadToDrive: applyUploadToDrive,
  manageDocument: applyManageDocument,
  manageRecord: applyManageRecord,
  installSkill: applyInstallSkill,
};
