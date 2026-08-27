import { z } from "@hono/zod-openapi";

/**
 * Tool permission policy — the 3-level `auto | approval | blocked` model that
 * governs which builtin agent tools and external-app actions a team (or a
 * connection owner) lets the assistant run, and whether a run pauses for a
 * human first. The same three levels apply to both surfaces:
 *
 *  - **builtin tools** → a team-wide policy map (`team_tool_policies.policies`),
 *    keyed by the tool's registry name, or by `"<tool>.<action>"` for one
 *    action of a multi-action tool. The catalog below declares each
 *    policy-managed tool's read/write kind, code default, selectable levels,
 *    which approval kind gates it when the resolved level is `approval`, and
 *    its per-action defaults where its actions differ in gravity.
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
/** Per-action levels stop at `approval`: `blocked` stays a tool-level decision,
 * because enforcement prunes the whole tool from the model's menu
 * (`policyHiddenToolNames`) and there is no way to hide a single action. */
export const ACTION_SELECTABLE_LEVELS = ["auto", "approval"] as const;

/**
 * Declares one action of a multi-action tool. A tool's `action` param carries
 * gestures of very different gravity — renaming a folder and deleting one are
 * not the same decision — so the level resolves per action, with the tool's own
 * `defaultLevel` as the net for any action without an entry here.
 */
export interface BuiltinToolActionPolicyDescriptor {
  /** `auto` or `approval` only — see `ACTION_SELECTABLE_LEVELS`. */
  defaultLevel: Exclude<ToolPolicyLevel, "blocked">;
  selectableLevels: readonly ToolPolicyLevel[];
  /** i18n key suffix under `settings.toolPermissions.actions.<tool>.*`. */
  labelKey: string;
}

/**
 * What part of the workspace a tool acts on. Purely an ORGANISING key: the
 * settings page lists one section per group so a 21-row list reads as five
 * short ones. It never affects resolution.
 */
export const TOOL_POLICY_GROUPS = [
  "records",
  "drive",
  "automation",
  "skills",
  "web",
] as const;
export type ToolPolicyGroup = (typeof TOOL_POLICY_GROUPS)[number];
export const toolPolicyGroupSchema = z.enum(TOOL_POLICY_GROUPS);

/**
 * Declares one policy-managed builtin tool. Pure data — feeds the zod
 * validation at the settings boundary, the resolver, the GET catalog, and the
 * frontend rows. Tools NOT listed in `BUILTIN_TOOL_POLICY_CATALOG` are
 * infrastructure/core (`python`, `bash`, `memory`, `searchTools`,
 * `dispatchAgent`, `askUserQuestion`, `presentFiles`,
 * `searchKnowledge`, `querySql`, `read`, `vision`, `completeTask`): always
 * available, never blockable — the assistant cannot function without them, and
 * `python`/`bash` side effects are gated downstream per external-app action.
 */
export interface BuiltinToolPolicyDescriptor {
  /** Registry key in the chatbot tool set, e.g. `manageRecord`. */
  name: string;
  group: ToolPolicyGroup;
  kind: "read" | "write";
  defaultLevel: ToolPolicyLevel;
  /** Levels a team may pick for this tool. */
  selectableLevels: readonly ToolPolicyLevel[];
  /** i18n key suffix under `settings.toolPermissions.tools.*` (= the name). */
  labelKey: string;
  /** Gate to run when the resolved level is `approval`. Write tools only. */
  approvalKind?: "record_write" | "tool_call";
  /** Per-action levels, keyed by the tool's `action` value. An action without
   * an entry resolves to `defaultLevel`. */
  actions?: Record<string, BuiltinToolActionPolicyDescriptor>;
}

/** A descriptor before its section stamps the group onto it. */
type UngroupedDescriptor = Omit<BuiltinToolPolicyDescriptor, "group">;

/** Stamps one group onto every descriptor of a catalog section. */
const inGroup = (
  group: ToolPolicyGroup,
  descriptors: UngroupedDescriptor[],
): Record<string, BuiltinToolPolicyDescriptor> =>
  Object.fromEntries(descriptors.map((d) => [d.name, { ...d, group }]));

const readTool = (name: string): UngroupedDescriptor => ({
  name,
  kind: "read",
  defaultLevel: "auto",
  selectableLevels: READ_SELECTABLE_LEVELS,
  labelKey: name,
});

/** Expands `{ createFolder: "auto", … }` into action descriptors. */
const actionDefaults = (
  defaults: Record<string, Exclude<ToolPolicyLevel, "blocked">>,
): Record<string, BuiltinToolActionPolicyDescriptor> =>
  Object.fromEntries(
    Object.entries(defaults).map(([name, defaultLevel]) => [
      name,
      {
        defaultLevel,
        selectableLevels: ACTION_SELECTABLE_LEVELS,
        labelKey: name,
      },
    ]),
  );

const writeTool = (
  name: string,
  approvalKind: "record_write" | "tool_call",
  actions?: Record<string, Exclude<ToolPolicyLevel, "blocked">>,
): UngroupedDescriptor => {
  const descriptor: UngroupedDescriptor = {
    name,
    kind: "write",
    defaultLevel: "approval",
    selectableLevels: WRITE_SELECTABLE_LEVELS,
    labelKey: name,
    approvalKind,
  };
  if (actions !== undefined) descriptor.actions = actionDefaults(actions);
  return descriptor;
};

/**
 * A write tool whose whole surface is additive and reversible — default `auto`
 * (no approval unless a team asks for one), still fully selectable/blockable.
 *
 * Use this, not `writeTool`, when EVERY action of the tool is classified
 * `auto` below. `writeTool`'s `approval` default is a net for actions the
 * catalog does not name; on a fully-classified additive tool that net catches
 * nothing, and it makes the settings row claim the tool asks for approval when
 * none of its actions ever will. Adding a destructive action to such a tool
 * means classifying it here AND moving the tool back to `writeTool`.
 */
const additiveWriteTool = (
  name: string,
  approvalKind: "record_write" | "tool_call",
  actions?: Record<string, Exclude<ToolPolicyLevel, "blocked">>,
): UngroupedDescriptor => {
  const descriptor: UngroupedDescriptor = {
    name,
    kind: "write",
    defaultLevel: "auto",
    selectableLevels: WRITE_SELECTABLE_LEVELS,
    labelKey: name,
    approvalKind,
  };
  if (actions !== undefined) descriptor.actions = actionDefaults(actions);
  return descriptor;
};

/**
 * A schema/automation config tool. Editing a schema is routine and `auto` by
 * default, but DROPPING one is not: a deleted collection takes its records
 * with it and a deleted or retyped field takes its column's values. Those
 * actions are approval-gated per action; the rest of the surface stays `auto`,
 * and a team can still turn the whole tool off.
 *
 * The tool-level default stays `auto` and tool-level `approval` is NOT
 * selectable: only the actions listed here have a grant executor
 * (`TOOL_CALL_APPLY`), so an approval on the whole tool would strand every
 * other action with nothing to run it. These tools are also FORBIDDEN in
 * workflow runs (`WORKFLOW_FORBIDDEN_DOMAIN_TOOLS`), so this gate is
 * chat-only.
 */
const configWriteTool = (
  name: string,
  actions?: Record<string, Exclude<ToolPolicyLevel, "blocked">>,
): UngroupedDescriptor => {
  const descriptor: UngroupedDescriptor = {
    name,
    kind: "write",
    defaultLevel: "auto",
    selectableLevels: READ_SELECTABLE_LEVELS,
    labelKey: name,
  };
  if (actions !== undefined) {
    descriptor.actions = actionDefaults(actions);
    descriptor.approvalKind = "tool_call";
  }
  return descriptor;
};

/**
 * The policy-managed builtin tools, keyed by registry name. Read tools default
 * `auto` (blockable); write tools map to their gate: `manageRecord` reuses the
 * rich `record_write` kind (dry-run + field-aware before/after card), the rest
 * use the generic `tool_call` kind.
 *
 * Write defaults follow one rule: ask for a human decision only when the write
 * can LOSE data irreversibly, reaches OUTSIDE the workspace, hits many rows at
 * once, or installs code the assistant will run. Everything else — additive,
 * reversible, and asked for by the user who is sitting right there — is `auto`,
 * because an approval card the user always clicks through is friction that
 * teaches them to stop reading the ones that matter. Workflow runs are NOT
 * governed by these defaults: their autonomy level overrides every write
 * (`resolveToolPolicy`), so a generous chat default never loosens a run.
 *
 * A tool's own `defaultLevel` stays the net for actions with no entry — add an
 * action to a tool's enum and it is gated until someone classifies it here.
 */
export const BUILTIN_TOOL_POLICY_CATALOG: Record<
  string,
  BuiltinToolPolicyDescriptor
> = {
  ...inGroup("records", [
    // Records carry no history: an overwrite or a delete cannot be undone, and
    // a bulk write reaches every row at once. Every action stays `approval`.
    writeTool("manageRecord", "record_write"),
    // Linking is reversible both ways — unlinking soft-invalidates the edge and
    // linking again brings it back. `link` and `unlink` are the whole enum.
    additiveWriteTool("manageLink", "tool_call", {
      link: "auto",
      unlink: "auto",
    }),
    configWriteTool("manageCollection", { delete: "approval" }),
    configWriteTool("manageField", {
      delete: "approval",
      changeType: "approval",
    }),
    readTool("listRecords"),
    readTool("getRecord"),
    readTool("describeCollection"),
  ]),

  ...inGroup("drive", [
    // Folder moves and renames are undoable and lose nothing; deleting a folder
    // takes its documents with it.
    writeTool("manageDrive", "tool_call", {
      createFolder: "auto",
      renameFolder: "auto",
      moveFolder: "auto",
      deleteFolder: "approval",
      moveDocument: "auto",
      renameDocument: "auto",
    }),
    // Every document write is versioned, so nothing is lost — a rollback can
    // itself be rolled back. `create`/`update`/`restore` are the tool's whole
    // write surface (`get` and `history` are reads and never reach the gate).
    additiveWriteTool("manageDocument", "tool_call", {
      create: "auto",
      update: "auto",
      restore: "auto",
    }),
    additiveWriteTool("uploadToDrive", "tool_call"),
    readTool("listDocuments"),
    readTool("listFolders"),
    readTool("downloadDriveDocument"),
  ]),

  ...inGroup("automation", [
    configWriteTool("manageWorkflow"),
    configWriteTool("managePage"),
  ]),

  ...inGroup("skills", [
    // Installs code the assistant will then run — the one security decision
    // in the catalog.
    writeTool("installSkill", "tool_call"),
    readTool("createSkill"),
    readTool("updateSkill"),
  ]),

  ...inGroup("web", [
    readTool("searchWeb"),
    readTool("webFetch"),
    readTool("searchIcons"),
  ]),
};

/** Names in the catalog — the only keys a team policy map may carry. */
export const POLICY_MANAGED_TOOL_NAMES = new Set(
  Object.keys(BUILTIN_TOOL_POLICY_CATALOG),
);

/**
 * Splits a policy map key into its tool and (optional) action. Overrides for a
 * single action live in the same sparse map under `"<tool>.<action>"`; neither
 * tool names nor action names contain a dot, so the first one separates them.
 */
export const parseToolPolicyKey = (
  key: string,
): { toolName: string; action?: string } => {
  const dot = key.indexOf(".");
  if (dot === -1) return { toolName: key };
  return { toolName: key.slice(0, dot), action: key.slice(dot + 1) };
};

/**
 * PATCH body for `team_tool_policies`: a sparse map keyed by builtin tool
 * name, or by `"<tool>.<action>"` for a single action. A level SETS the
 * override; `null` RESETS to the default (deletes the key). Names + levels are
 * re-validated against the catalog in the handler (a name outside the catalog,
 * an action the tool does not declare, or a level outside the relevant
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

/** One action row nested under its tool in the GET catalog response. */
export const builtinToolPolicyActionEntrySchema = z.object({
  name: z.string(),
  defaultLevel: toolPolicyLevelSchema,
  selectableLevels: z.array(toolPolicyLevelSchema),
  labelKey: z.string(),
  /** The team's stored override for THIS action, or null. */
  override: toolPolicyLevelSchema.nullable(),
  /** What the action resolves to WITHOUT an action override — the tool's
   * override if it has one, else the action's default. This is the value the
   * UI resets to (sending `null`), not `defaultLevel`: a team that set the
   * whole tool to `approval` expects a reset action to follow the tool. */
  baselineLevel: toolPolicyLevelSchema,
  /** `override ?? baselineLevel`. */
  effectiveLevel: toolPolicyLevelSchema,
});
export type BuiltinToolPolicyActionEntry = z.infer<
  typeof builtinToolPolicyActionEntrySchema
>;

/** One row in the GET `/tool-policies` catalog response. */
export const builtinToolPolicyEntrySchema = z.object({
  name: z.string(),
  group: toolPolicyGroupSchema,
  kind: z.enum(["read", "write"]),
  defaultLevel: toolPolicyLevelSchema,
  selectableLevels: z.array(toolPolicyLevelSchema),
  labelKey: z.string(),
  /** The team's stored override, or null when using the default. */
  override: toolPolicyLevelSchema.nullable(),
  /** Default when no override, else the override (autonomy not applied — this
   * is the team's chat-scope setting the UI edits). */
  effectiveLevel: toolPolicyLevelSchema,
  /** Present only for multi-action tools. */
  actions: z.array(builtinToolPolicyActionEntrySchema).optional(),
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
