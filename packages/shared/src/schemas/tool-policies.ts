import { z } from "@hono/zod-openapi";

/**
 * Tool permission policy — the 3-level `auto | approval | blocked` model that
 * governs which builtin agent tools and external-app actions a team (or a
 * connection owner) lets the assistant run, and whether a run pauses for a
 * human first. The same three levels apply to both surfaces:
 *
 *  - **builtin tools** → a team-wide policy map (`team_tool_policies.policies`),
 *    keyed by the tool's registry name. The catalog below declares each
 *    policy-managed tool's read/write kind, code default, selectable levels,
 *    and which approval kind gates it when the resolved level is `approval`.
 *  - **external-app actions** → a per-connection policy map
 *    (`external_app_connections.action_policies`), keyed by the action name.
 *    Manifests are the registry there (`action.kind: 'read'|'write'` → default
 *    `auto`/`approval`), so actions need no descriptors here.
 *
 * Resolution (team/connection override + workflow autonomy) lives in
 * `services/tool-policies/resolve.ts`; enforcement is defense-in-depth
 * (activeTools prune + server backstop for builtin tools, dispatch gate for
 * external-app actions).
 */

export const TOOL_POLICY_LEVELS = ["auto", "approval", "blocked"] as const;
export const toolPolicyLevelSchema = z.enum(TOOL_POLICY_LEVELS);
export type ToolPolicyLevel = (typeof TOOL_POLICY_LEVELS)[number];

/** Read tools are never approval-gated (no gated executor); teams may only
 * turn them off. Write tools support the full range. */
export const READ_SELECTABLE_LEVELS = ["auto", "blocked"] as const;
export const WRITE_SELECTABLE_LEVELS = ["auto", "approval", "blocked"] as const;

/**
 * Declares one policy-managed builtin tool. Pure data — feeds the zod
 * validation at the settings boundary, the resolver, the GET catalog, and the
 * frontend rows. Tools NOT listed in `BUILTIN_TOOL_POLICY_CATALOG` are
 * infrastructure/core (`python`, `bash`, `memory`, `searchTools`,
 * `dispatchAgent`, `manageTasks`, `askUserQuestion`, `presentFiles`,
 * `searchKnowledge`, `querySql`, `read`, `vision`, `completeTask`): always
 * available, never blockable — the assistant cannot function without them, and
 * `python`/`bash` side effects are gated downstream per external-app action.
 */
export interface BuiltinToolPolicyDescriptor {
  /** Registry key in the chatbot tool set, e.g. `manageRecord`. */
  name: string;
  kind: "read" | "write";
  defaultLevel: ToolPolicyLevel;
  /** Levels a team may pick for this tool. */
  selectableLevels: readonly ToolPolicyLevel[];
  /** i18n key suffix under `settings.toolPermissions.tools.*` (= the name). */
  labelKey: string;
  /** Gate to run when the resolved level is `approval`. Write tools only. */
  approvalKind?: "record_write" | "tool_call";
}

const readTool = (name: string): BuiltinToolPolicyDescriptor => ({
  name,
  kind: "read",
  defaultLevel: "auto",
  selectableLevels: READ_SELECTABLE_LEVELS,
  labelKey: name,
});

const writeTool = (
  name: string,
  approvalKind: "record_write" | "tool_call",
): BuiltinToolPolicyDescriptor => ({
  name,
  kind: "write",
  defaultLevel: "approval",
  selectableLevels: WRITE_SELECTABLE_LEVELS,
  labelKey: name,
  approvalKind,
});

/**
 * A write tool that is BLOCKABLE but not (yet) approval-gated. Default `auto`
 * (today's behaviour), levels `auto | blocked`, no `approvalKind`. Used for the
 * schema/automation config tools (`manageObjectType`, `manageField`,
 * `manageWorkflow`): they are FORBIDDEN in every workflow run
 * (`WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`) and run directly in chat, so they never
 * reach the approval gate — an approval level would have no executor. A team
 * can still turn them off entirely. Approval-gating them (chat-time review of
 * schema edits) is a follow-up needing their per-action proposal payloads.
 */
const configWriteTool = (name: string): BuiltinToolPolicyDescriptor => ({
  name,
  kind: "write",
  defaultLevel: "auto",
  selectableLevels: READ_SELECTABLE_LEVELS,
  labelKey: name,
});

/**
 * The policy-managed builtin tools, keyed by registry name. Read tools default
 * `auto` (blockable); write tools default `approval` and map to their gate:
 * `manageRecord` reuses the rich `record_write` kind (dry-run + field-aware
 * before/after card); the rest use the generic `tool_call` kind.
 */
export const BUILTIN_TOOL_POLICY_CATALOG: Record<
  string,
  BuiltinToolPolicyDescriptor
> = {
  // Read path — browse/inspect the workspace. Blockable, never approval.
  listDocuments: readTool("listDocuments"),
  describeObjectType: readTool("describeObjectType"),
  listObjects: readTool("listObjects"),
  getObject: readTool("getObject"),
  listFolders: readTool("listFolders"),
  searchIcons: readTool("searchIcons"),
  searchWeb: readTool("searchWeb"),
  webFetch: readTool("webFetch"),
  downloadDriveDocument: readTool("downloadDriveDocument"),
  createSkill: readTool("createSkill"),
  updateSkill: readTool("updateSkill"),

  // Write path — mutate team data. Default approval (gated).
  manageRecord: writeTool("manageRecord", "record_write"),
  manageLink: writeTool("manageLink", "tool_call"),
  manageDrive: writeTool("manageDrive", "tool_call"),
  uploadToDrive: writeTool("uploadToDrive", "tool_call"),
  installSkill: writeTool("installSkill", "tool_call"),

  // Config write — blockable only (auto default, no approval gate yet).
  manageObjectType: configWriteTool("manageObjectType"),
  manageField: configWriteTool("manageField"),
  manageWorkflow: configWriteTool("manageWorkflow"),
};

/** Names in the catalog — the only keys a team policy map may carry. */
export const POLICY_MANAGED_TOOL_NAMES = new Set(
  Object.keys(BUILTIN_TOOL_POLICY_CATALOG),
);

/**
 * PATCH body for `team_tool_policies`: a sparse map keyed by builtin tool
 * name. A level SETS the override; `null` RESETS to the code default (deletes
 * the key). Names + levels are re-validated against the catalog in the
 * handler (a name outside the catalog, or a level outside the tool's
 * `selectableLevels`, is rejected).
 */
export const teamToolPoliciesPatchSchema = z.record(
  z.string(),
  toolPolicyLevelSchema.nullable(),
);
export type TeamToolPoliciesPatch = z.infer<typeof teamToolPoliciesPatchSchema>;

/** Per-connection action policy patch — same sparse semantics, keyed by
 * action name (validated against the connection provider's manifest). */
export const connectionActionPoliciesPatchSchema = z.record(
  z.string(),
  toolPolicyLevelSchema.nullable(),
);
export type ConnectionActionPoliciesPatch = z.infer<
  typeof connectionActionPoliciesPatchSchema
>;

/** One row in the GET `/tool-policies` catalog response. */
export const builtinToolPolicyEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["read", "write"]),
  defaultLevel: toolPolicyLevelSchema,
  selectableLevels: z.array(toolPolicyLevelSchema),
  labelKey: z.string(),
  /** The team's stored override, or null when using the default. */
  override: toolPolicyLevelSchema.nullable(),
  /** Default when no override, else the override (autonomy not applied — this
   * is the team's chat-scope setting the UI edits). */
  effectiveLevel: toolPolicyLevelSchema,
});
export type BuiltinToolPolicyEntry = z.infer<
  typeof builtinToolPolicyEntrySchema
>;

export const toolPoliciesCatalogResponseSchema = z.object({
  tools: z.array(builtinToolPolicyEntrySchema),
});
export type ToolPoliciesCatalogResponse = z.infer<
  typeof toolPoliciesCatalogResponseSchema
>;
