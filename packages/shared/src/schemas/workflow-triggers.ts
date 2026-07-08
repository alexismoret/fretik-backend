import { z } from "zod";
import { WORKFLOW_TRIGGERABLE_EVENT_TYPES } from "../services/domain-events/event-types";
import {
  WORKFLOW_TRIGGER_TYPE_VALUES,
  WorkflowTriggerConfigSchema,
  workflowTriggerTypeSchema,
  type WorkflowTriggerType,
} from "./workflows";

/**
 * The trigger registry — ONE source of truth describing every workflow trigger
 * kind and its editable parameters. It feeds four consumers so a trigger or a
 * parameter is declared exactly once:
 *   1. frontend — the trigger editor dispatches a Vue control per `param.kind`;
 *   2. chatbot  — `describeTriggerConfigForAgent()` + the `get_trigger_catalog`
 *      action expose the same params to the agent;
 *   3. API      — `GET /workflows/trigger-catalog` serves `buildTriggerCatalog()`;
 *   4. backend  — the event matcher reads `triggerConfig.event.filter` (the flat
 *      equality map the descriptors write into).
 *
 * The raw config Zod (`WorkflowCronConfigSchema` / `WorkflowEventConfigSchema` /
 * `WorkflowTriggerConfigSchema`) stays in `./workflows` (imported by the DB
 * schema); this file only adds the descriptor layer on top — one-directional
 * (`workflow-triggers` ← `workflows`), never the reverse, to keep the import
 * graph acyclic.
 *
 * Adding a trigger KIND: add the value to `WORKFLOW_TRIGGER_TYPE_VALUES`
 * (auto-propagates to the pgEnum + Zod), a `Workflow<Kind>ConfigSchema` in
 * `./workflows`, an entry in `WORKFLOW_TRIGGER_KINDS` below, a frontend
 * `<Kind>TriggerEditor.vue`, and a matcher/dispatch path. Adding a per-event
 * PARAM: append a `TriggerParameterDescriptor` to that event's entry in
 * `WORKFLOW_TRIGGERABLE_EVENT_DESCRIPTORS` (and enrich the emitted payload so
 * the flat matcher can see the key). Mark not-yet-wired params `available:false`
 * — the UI disables them and the agent catalog flags them "coming soon".
 */

// ==================== //
// PARAMETER DESCRIPTOR //
// ==================== //

/**
 * The widget/semantic type of one editable trigger parameter. The frontend maps
 * each `kind` to a control component; `json_schema` (Form trigger) and
 * `connection` (external-app) are reserved seams, rendered disabled until wired.
 */
export const TRIGGER_PARAMETER_KINDS = [
  "cron",
  "timezone",
  "event_type",
  "folder",
  "object_type",
  "text",
  "number",
  "boolean",
  "select",
  "key_value",
  "json_schema",
  "connection",
] as const;
export type TriggerParameterKind = (typeof TRIGGER_PARAMETER_KINDS)[number];

export const TriggerParameterOptionSchema = z.object({
  value: z.string(),
  labelKey: z.string(),
});

export const TriggerParameterDescriptorSchema = z.object({
  /** Dot-path into `triggerConfig`, e.g. "cron.pattern", "event.filter.folderId". */
  key: z.string(),
  kind: z.enum(TRIGGER_PARAMETER_KINDS),
  /** Stable i18n key — the frontend owns the English copy. */
  labelKey: z.string(),
  /** Lucide icon id (`i-lucide-*`) for the param row. */
  icon: z.string().optional(),
  required: z.boolean(),
  /** false = declared but not yet wired (UI disables it, agent skips it). */
  available: z.boolean(),
  /** One-line, agent-facing: what the value is + how to obtain it. */
  agentHint: z.string().optional(),
  /** For kind "select" — the allowed values. */
  options: z.array(TriggerParameterOptionSchema).optional(),
});
export type TriggerParameterDescriptor = z.infer<
  typeof TriggerParameterDescriptorSchema
>;

/** Author a descriptor with `available: true` as the default. */
const param = (
  p: Omit<TriggerParameterDescriptor, "available"> & { available?: boolean },
): TriggerParameterDescriptor => ({ available: true, ...p });

// ==================== //
// TRIGGER KIND         //
// ==================== //

export const WorkflowTriggerKindDescriptorSchema = z.object({
  type: workflowTriggerTypeSchema,
  /** Lucide icon id (`i-lucide-*`). */
  icon: z.string(),
  labelKey: z.string(),
  descriptionKey: z.string(),
  /** Where this kind's params live inside `triggerConfig` (absent for manual). */
  configKey: z.enum(["cron", "event"]).optional(),
  /** cron → a Trigger.dev schedule is attached on activation. */
  requiresSchedule: z.boolean(),
  /** Base params. An event kind's contextual params come from the event-type
   * descriptor selected in `event.type`. */
  params: z.array(TriggerParameterDescriptorSchema),
  /** Seed config when the user first picks this kind (plain value — clone
   * before mutating on the backend). */
  defaultConfig: WorkflowTriggerConfigSchema,
  /** One-line agent-facing summary. */
  agentSummary: z.string(),
});
export type WorkflowTriggerKindDescriptor = z.infer<
  typeof WorkflowTriggerKindDescriptorSchema
>;

export const WORKFLOW_TRIGGER_KINDS: Record<
  WorkflowTriggerType,
  WorkflowTriggerKindDescriptor
> = {
  manual: {
    type: "manual",
    icon: "i-lucide-mouse-pointer-click",
    labelKey: "workflows.trigger.manual",
    descriptionKey: "workflows.triggerCard.manualSub",
    requiresSchedule: false,
    params: [],
    defaultConfig: {},
    agentSummary:
      "manual — a person starts it on demand (the Run button / run_test). No parameters.",
  },
  cron: {
    type: "cron",
    icon: "i-lucide-calendar-clock",
    labelKey: "workflows.trigger.cron",
    descriptionKey: "workflows.triggerCard.cronSub",
    configKey: "cron",
    requiresSchedule: true,
    params: [
      param({
        key: "cron.pattern",
        kind: "cron",
        labelKey: "workflows.triggerParams.cronPattern",
        icon: "i-lucide-calendar-clock",
        required: true,
        agentHint:
          "5-field cron pattern (minute hour day month weekday), e.g. '0 9 * * 1-5' = weekdays at 09:00.",
      }),
      param({
        key: "cron.timezone",
        kind: "timezone",
        labelKey: "workflows.triggerParams.timezone",
        icon: "i-lucide-globe",
        required: false,
        agentHint: "IANA timezone (e.g. 'Europe/Paris'); omit for UTC.",
      }),
    ],
    defaultConfig: { cron: { pattern: "0 9 * * *" } },
    agentSummary:
      "cron — runs on a schedule. triggerConfig.cron = { pattern (5-field, required), timezone (IANA, optional) }.",
  },
  event: {
    type: "event",
    icon: "i-lucide-webhook",
    labelKey: "workflows.trigger.event",
    descriptionKey: "workflows.triggerCard.eventSub",
    configKey: "event",
    requiresSchedule: false,
    params: [
      param({
        key: "event.type",
        kind: "event_type",
        labelKey: "workflows.triggerParams.eventType",
        icon: "i-lucide-webhook",
        required: true,
        agentHint: `Journal event type to match — one of ${WORKFLOW_TRIGGERABLE_EVENT_TYPES.join(", ")} or a connector.<app>.<kind> event.`,
      }),
      param({
        key: "event.filter",
        kind: "key_value",
        labelKey: "workflows.triggerParams.filter",
        icon: "i-lucide-filter",
        required: false,
        agentHint:
          "Optional equality filter on the event payload — every entry must match (payload[key] === value). The meaningful keys per event type are in the catalog's eventTypes.",
      }),
    ],
    defaultConfig: { event: { type: "document.uploaded" } },
    agentSummary:
      "event — fires when a workspace event occurs. triggerConfig.event = { type (required), filter (payload equality, optional) }. Per-event-type filter keys are in the trigger catalog.",
  },
};

// ==================== //
// EVENT-TYPE DESCRIPTORS
// ==================== //

export const WorkflowEventTypeDescriptorSchema = z.object({
  type: z.string(),
  icon: z.string(),
  labelKey: z.string(),
  /** Contextual filter params meaningful for THIS event type — each writes into
   * `event.filter.<key>` and is matched by the flat sweep equality. */
  params: z.array(TriggerParameterDescriptorSchema),
});
export type WorkflowEventTypeDescriptor = z.infer<
  typeof WorkflowEventTypeDescriptorSchema
>;

/** Scaffolded (not yet wired) — record.* object-type filter. Declared so the
 * pattern is visible; needs `objectTypeKey` on the record.* payload to work. */
const objectTypeFilterParam = param({
  key: "event.filter.objectTypeKey",
  kind: "object_type",
  labelKey: "workflows.triggerParams.objectType",
  icon: "i-lucide-shapes",
  required: false,
  available: false,
  agentHint:
    "Only fire for records of this object type (by type key). Not yet available.",
});

export const WORKFLOW_TRIGGERABLE_EVENT_DESCRIPTORS: WorkflowEventTypeDescriptor[] =
  [
    {
      type: "document.uploaded",
      icon: "i-lucide-file-up",
      labelKey: "workflows.eventTypes.document_uploaded",
      params: [
        param({
          key: "event.filter.folderId",
          kind: "folder",
          labelKey: "workflows.triggerParams.folder",
          icon: "i-lucide-folder",
          required: false,
          agentHint:
            "Only fire when the document was uploaded into this folder. Value = a folder id (obtain it via the drive/objects tools). Omit to fire for any folder.",
        }),
      ],
    },
    {
      type: "document.deleted",
      icon: "i-lucide-file-x",
      labelKey: "workflows.eventTypes.document_deleted",
      params: [],
    },
    {
      type: "document.reextracted",
      icon: "i-lucide-file-search",
      labelKey: "workflows.eventTypes.document_reextracted",
      params: [],
    },
    {
      type: "record.created",
      icon: "i-lucide-circle-plus",
      labelKey: "workflows.eventTypes.record_created",
      params: [objectTypeFilterParam],
    },
    {
      type: "record.updated",
      icon: "i-lucide-pencil",
      labelKey: "workflows.eventTypes.record_updated",
      params: [objectTypeFilterParam],
    },
    {
      type: "record.deleted",
      icon: "i-lucide-circle-minus",
      labelKey: "workflows.eventTypes.record_deleted",
      params: [],
    },
    {
      type: "record.confirmed",
      icon: "i-lucide-circle-check",
      labelKey: "workflows.eventTypes.record_confirmed",
      params: [],
    },
    {
      type: "record.rejected",
      icon: "i-lucide-circle-x",
      labelKey: "workflows.eventTypes.record_rejected",
      params: [],
    },
    {
      type: "link.created",
      icon: "i-lucide-link",
      labelKey: "workflows.eventTypes.link_created",
      params: [],
    },
    {
      type: "link.invalidated",
      icon: "i-lucide-unlink",
      labelKey: "workflows.eventTypes.link_invalidated",
      params: [],
    },
    {
      type: "folder.created",
      icon: "i-lucide-folder-plus",
      labelKey: "workflows.eventTypes.folder_created",
      params: [],
    },
    {
      type: "folder.renamed",
      icon: "i-lucide-folder-pen",
      labelKey: "workflows.eventTypes.folder_renamed",
      params: [],
    },
    {
      type: "folder.deleted",
      icon: "i-lucide-folder-x",
      labelKey: "workflows.eventTypes.folder_deleted",
      params: [],
    },
  ];

// ==================== //
// CATALOG + AGENT      //
// ==================== //

export const TriggerCatalogSchema = z.object({
  triggerTypes: z.array(WorkflowTriggerKindDescriptorSchema),
  eventTypes: z.array(WorkflowEventTypeDescriptorSchema),
});
export type TriggerCatalog = z.infer<typeof TriggerCatalogSchema>;

/**
 * The full machine-readable trigger catalog — every kind + every event-type's
 * contextual params. Served by `GET /workflows/trigger-catalog` and the
 * `manageWorkflow` `get_trigger_catalog` action. Static today; a team-aware
 * overload will fold in connector-contributed event descriptors later.
 */
export const buildTriggerCatalog = (): TriggerCatalog => ({
  triggerTypes: WORKFLOW_TRIGGER_TYPE_VALUES.map(
    (t) => WORKFLOW_TRIGGER_KINDS[t],
  ),
  eventTypes: WORKFLOW_TRIGGERABLE_EVENT_DESCRIPTORS,
});

/** Compact trigger reference for the `manageWorkflow` tool — generated from the
 * registry so the agent contract never drifts from the editor's. */
export const describeTriggerConfigForAgent = (): string => {
  const kinds = WORKFLOW_TRIGGER_TYPE_VALUES.map(
    (t) => `- ${WORKFLOW_TRIGGER_KINDS[t].agentSummary}`,
  );
  const eventParams = WORKFLOW_TRIGGERABLE_EVENT_DESCRIPTORS.filter((e) =>
    e.params.some((p) => p.available),
  ).map((e) => {
    const keys = e.params
      .filter((p) => p.available)
      .map((p) => p.key.split(".").pop())
      .join(", ");
    return `  · ${e.type} → filter keys: ${keys}`;
  });
  return [
    "triggerConfig shape depends on triggerType:",
    ...kinds,
    ...(eventParams.length
      ? ["Event-type filter keys (write into event.filter):", ...eventParams]
      : []),
    "Use action get_trigger_catalog for the full machine-readable catalog.",
  ].join("\n");
};
