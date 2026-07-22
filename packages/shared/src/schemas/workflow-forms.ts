import { z } from "zod";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_FILES_PER_MESSAGE,
} from "../utils/chatbot-limits";

/**
 * Form trigger config — the shape of a workflow whose `triggerType` is
 * `"form"`. A person fills the form on the public page `/f/<token>`; the
 * submission creates a run whose `triggerPayload` is the answers (and any
 * uploaded files are attached to the run).
 *
 * Kept db-free (pure Zod, like `schemas/workflow-triggers.ts`): imported by
 * `schemas/workflows.ts` (which folds it into `WorkflowTriggerConfigSchema`),
 * the API validation boundary, the trigger catalog, and — mirrored by hand —
 * the frontend types. This is a self-contained field system, deliberately
 * decoupled from the object/records field model so the public renderer stays
 * anonymous-safe.
 *
 * WRITE validation here is LENIENT (a half-built draft autosaves): title and
 * fields may be empty, a select need not yet have options. COMPLETENESS is
 * enforced at activation (`workflowFormActivationError`) — same split as the
 * cron "requires a pattern" check.
 */

// ==================== //
// FIELD TYPES          //
// ==================== //

export const WORKFLOW_FORM_FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "email",
  "url",
  "phone",
  "date",
  "select",
  "multi_select",
  "checkbox",
  "file",
] as const;
export const workflowFormFieldTypeSchema = z.enum(WORKFLOW_FORM_FIELD_TYPES);
export type WorkflowFormFieldType = z.infer<typeof workflowFormFieldTypeSchema>;

export const WORKFLOW_FORM_VISIBILITY_VALUES = ["public", "private"] as const;
export const workflowFormVisibilitySchema = z.enum(
  WORKFLOW_FORM_VISIBILITY_VALUES,
);
export type WorkflowFormVisibility = z.infer<
  typeof workflowFormVisibilitySchema
>;

/** Field-key: a stable slug used as the `triggerPayload` key. */
const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,59}$/;

/** Platform caps. `maxFiles`/`maxFileSizeMb` reuse the chat-file ceilings so a
 * form upload never exceeds what the agent's file pipeline accepts. */
export const WORKFLOW_FORM_MAX_FIELDS = 40;
export const WORKFLOW_FORM_FILE_MAX_MB = Math.floor(
  MAX_FILE_SIZE_BYTES / (1024 * 1024),
);

export const WorkflowFormFieldOptionSchema = z.object({
  value: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  /** Optional display color/icon (a select field renders coloured choices,
   * reusing the object field option editor). */
  color: z.string().max(20).optional(),
  icon: z.string().max(60).optional(),
});
export type WorkflowFormFieldOption = z.infer<
  typeof WorkflowFormFieldOptionSchema
>;

/**
 * One form field. The constraint bag is flat and every constraint is optional
 * — which ones are MEANINGFUL for a given type is described by
 * `WORKFLOW_FORM_FIELD_DESCRIPTORS`; the renderer/validator read only the ones
 * that apply. Cross-field sanity (min ≤ max) is checked here; per-type
 * completeness (a select needs options, every field needs a label) is checked
 * at activation.
 */
export const WorkflowFormFieldSchema = z
  .object({
    key: z
      .string()
      .regex(
        FIELD_KEY_RE,
        "field key must be 1-60 chars: a-z, 0-9 or _, starting with a letter",
      ),
    type: workflowFormFieldTypeSchema,
    label: z.string().max(200).default(""),
    description: z.string().max(1000).optional(),
    placeholder: z.string().max(200).optional(),
    required: z.boolean().default(false),
    // text (short_text / long_text)
    minLength: z.number().int().nonnegative().max(100_000).optional(),
    maxLength: z.number().int().positive().max(100_000).optional(),
    // number
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
    // select / multi_select
    options: z.array(WorkflowFormFieldOptionSchema).max(200).optional(),
    // file
    accept: z.array(z.string().max(150)).max(50).optional(),
    maxFiles: z.number().int().positive().max(MAX_FILES_PER_MESSAGE).optional(),
    maxFileSizeMb: z
      .number()
      .int()
      .positive()
      .max(WORKFLOW_FORM_FILE_MAX_MB)
      .optional(),
  })
  .superRefine((f, ctx) => {
    if (
      f.minLength !== undefined &&
      f.maxLength !== undefined &&
      f.minLength > f.maxLength
    ) {
      ctx.addIssue({
        code: "custom",
        message: `field "${f.key}": minLength must not exceed maxLength`,
        path: ["minLength"],
      });
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
      ctx.addIssue({
        code: "custom",
        message: `field "${f.key}": min must not exceed max`,
        path: ["min"],
      });
    }
  });
export type WorkflowFormField = z.infer<typeof WorkflowFormFieldSchema>;

export const WorkflowFormConfigSchema = z
  .object({
    title: z.string().max(200).default(""),
    description: z.string().max(4000).optional(),
    fields: z
      .array(WorkflowFormFieldSchema)
      .max(WORKFLOW_FORM_MAX_FIELDS)
      .default([]),
    /** public = anyone with the link; private = falls back to the workflow's
     * own scope (team-shared → team members; user-scoped → owner). */
    visibility: workflowFormVisibilitySchema.default("private"),
    submitLabel: z.string().max(60).optional(),
    successMessage: z.string().max(2000).optional(),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    for (const field of cfg.fields) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate field key "${field.key}"`,
          path: ["fields"],
        });
      }
      seen.add(field.key);
    }
  });
export type WorkflowFormConfig = z.infer<typeof WorkflowFormConfigSchema>;

/**
 * COMPLETENESS gate, run at activation (a draft form autosaves incomplete).
 * Returns an error message, or null when the form is ready to serve.
 */
export const workflowFormActivationError = (
  config: WorkflowFormConfig,
): string | null => {
  if (!config.title.trim()) return "The form needs a title to activate.";
  if (config.fields.length === 0) {
    return "The form needs at least one field to activate.";
  }
  for (const field of config.fields) {
    if (!field.label.trim()) {
      return `Field "${field.key}" needs a label to activate.`;
    }
    if (
      (field.type === "select" || field.type === "multi_select") &&
      (!field.options || field.options.length === 0)
    ) {
      return `Field "${field.key}" needs at least one option to activate.`;
    }
  }
  return null;
};

// ==================== //
// FIELD DESCRIPTORS    //
// (catalog + agent)    //
// ==================== //

export const WORKFLOW_FORM_FIELD_CONSTRAINTS = [
  "minLength",
  "maxLength",
  "min",
  "max",
  "step",
  "options",
  "accept",
  "maxFiles",
  "maxFileSizeMb",
] as const;
export const workflowFormFieldConstraintSchema = z.enum(
  WORKFLOW_FORM_FIELD_CONSTRAINTS,
);

export const WorkflowFormFieldDescriptorSchema = z.object({
  type: workflowFormFieldTypeSchema,
  labelKey: z.string(),
  icon: z.string(),
  /** Which of the constraint-bag keys are meaningful for this type — drives
   * the builder's per-type controls and the agent catalog. */
  constraints: z.array(workflowFormFieldConstraintSchema),
  /** One-line, agent-facing: what this field type collects. */
  agentHint: z.string(),
});
export type WorkflowFormFieldDescriptor = z.infer<
  typeof WorkflowFormFieldDescriptorSchema
>;

/** ONE source describing every form field type — read by the frontend builder
 * (type picker + which constraint controls to show) and the agent catalog. */
export const WORKFLOW_FORM_FIELD_DESCRIPTORS: WorkflowFormFieldDescriptor[] = [
  {
    type: "short_text",
    labelKey: "workflows.form.fieldTypes.short_text",
    icon: "i-lucide-type",
    constraints: ["minLength", "maxLength"],
    agentHint: "single-line text.",
  },
  {
    type: "long_text",
    labelKey: "workflows.form.fieldTypes.long_text",
    icon: "i-lucide-text",
    constraints: ["minLength", "maxLength"],
    agentHint: "multi-line text (textarea).",
  },
  {
    type: "number",
    labelKey: "workflows.form.fieldTypes.number",
    icon: "i-lucide-hash",
    constraints: ["min", "max", "step"],
    agentHint: "a number, with optional min/max/step.",
  },
  {
    type: "email",
    labelKey: "workflows.form.fieldTypes.email",
    icon: "i-lucide-mail",
    constraints: [],
    agentHint: "an email address (format-validated).",
  },
  {
    type: "url",
    labelKey: "workflows.form.fieldTypes.url",
    icon: "i-lucide-link",
    constraints: [],
    agentHint: "a URL (format-validated).",
  },
  {
    type: "phone",
    labelKey: "workflows.form.fieldTypes.phone",
    icon: "i-lucide-phone",
    constraints: [],
    agentHint: "a phone number.",
  },
  {
    type: "date",
    labelKey: "workflows.form.fieldTypes.date",
    icon: "i-lucide-calendar",
    constraints: [],
    agentHint: "a date.",
  },
  {
    type: "select",
    labelKey: "workflows.form.fieldTypes.select",
    icon: "i-lucide-circle-dot",
    constraints: ["options"],
    agentHint: "pick one of `options` ({ value, label }).",
  },
  {
    type: "multi_select",
    labelKey: "workflows.form.fieldTypes.multi_select",
    icon: "i-lucide-list-checks",
    constraints: ["options"],
    agentHint: "pick several of `options`.",
  },
  {
    type: "checkbox",
    labelKey: "workflows.form.fieldTypes.checkbox",
    icon: "i-lucide-square-check",
    constraints: [],
    agentHint: "a single yes/no checkbox.",
  },
  {
    type: "file",
    labelKey: "workflows.form.fieldTypes.file",
    icon: "i-lucide-paperclip",
    constraints: ["accept", "maxFiles", "maxFileSizeMb"],
    agentHint:
      "file upload; `accept` = MIME allowlist, `maxFiles`, `maxFileSizeMb`. Files attach to the run.",
  },
];

/** Compact form-field reference for the `manageWorkflow` tool — generated from
 * the descriptors so the agent contract never drifts from the builder's. */
export const describeFormFieldsForAgent = (): string =>
  [
    "Form field types (triggerConfig.form.fields[].type):",
    ...WORKFLOW_FORM_FIELD_DESCRIPTORS.map(
      (d) => `  · ${d.type} — ${d.agentHint}`,
    ),
  ].join("\n");

// ==================== //
// PUBLIC VIEW (API)    //
// ==================== //

/** Public-safe projection of a form workflow, served on the `/f/<token>`
 * page. Carries the form definition plus the workflow/org/team display info —
 * no run internals, no playbook, no owner identity. */
export const PublicFormViewSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  fields: z.array(WorkflowFormFieldSchema),
  visibility: workflowFormVisibilitySchema,
  submitLabel: z.string().optional(),
  successMessage: z.string().optional(),
  workflowName: z.string(),
  workflowDescription: z.string(),
  workflowIcon: z.string().nullable(),
  organizationName: z.string(),
  /** Org logo URL for the page header avatar; null when the org has none. */
  organizationLogo: z.string().nullable(),
  teamName: z.string(),
});
export type PublicFormView = z.infer<typeof PublicFormViewSchema>;

/** The GET result: an access verdict + the form (only when `ready`). */
export const PUBLIC_FORM_ACCESS_VALUES = [
  "ready",
  "not_found",
  "inactive",
  "login_required",
  "forbidden",
] as const;
export const publicFormAccessSchema = z.enum(PUBLIC_FORM_ACCESS_VALUES);
export type PublicFormAccess = z.infer<typeof publicFormAccessSchema>;

/** How this form was reached: `live` = an active workflow (real submission);
 * `test` = a member dry-running a draft/paused workflow through its own form. */
export const PUBLIC_FORM_MODE_VALUES = ["live", "test"] as const;
export const publicFormModeSchema = z.enum(PUBLIC_FORM_MODE_VALUES);
export type PublicFormMode = z.infer<typeof publicFormModeSchema>;

export const PublicFormResponseSchema = z.object({
  access: publicFormAccessSchema,
  /** Present only when `access` is `ready`. */
  mode: publicFormModeSchema.optional(),
  form: PublicFormViewSchema.optional(),
});
export type PublicFormResponse = z.infer<typeof PublicFormResponseSchema>;

export const PublicFormSubmitResponseSchema = z.object({
  ok: z.literal(true),
  successMessage: z.string().optional(),
  /** Set only for a test submission — lets the cockpit link straight to the
   * run it just started (`/workflows/{workflowId}?run={runId}`). */
  runId: z.string().optional(),
  workflowId: z.string().optional(),
});
export type PublicFormSubmitResponse = z.infer<
  typeof PublicFormSubmitResponseSchema
>;
