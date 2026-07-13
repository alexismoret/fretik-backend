import { recordSharingSchema } from "../../schemas/object-sharing";
import { recordRelationInputSchema } from "../../schemas/ontology";
import { promoteChatFilesToDrive } from "../chat-files/promote-to-drive";
import { updateDocument } from "../documents/update";
import type { EventActor } from "../domain-events/emit";
import { createFolder } from "../folders/create";
import { deleteFolders } from "../folders/delete";
import { updateFolder } from "../folders/update";
import { createLink } from "../links/create";
import { invalidateLink } from "../links/invalidate";
import { createObjectRecord } from "../object-records/create";
import { deleteObjectRecord } from "../object-records/delete";
import { setRecordStatus } from "../object-records/set-status";
import { setRecordData } from "../object-records/update";
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
 * (`manageObjectType`, `manageField`, `manageWorkflow`) are blockable-only (no
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
  // moveDocument
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

// ---- uploadToDrive --------------------------------------------------------

const applyUploadToDrive: ToolCallApplyFn = async (ctx, args) => {
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
    const record = await createObjectRecord({
      organizationId: ctx.organizationId,
      teamId: ctx.teamId,
      userId: ctx.userId,
      objectTypeId: str(args, "objectTypeId"),
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
    const result = await deleteObjectRecord({
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
  manageRecord: applyManageRecord,
  installSkill: applyInstallSkill,
};
