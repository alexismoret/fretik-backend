import type { Workflow } from "../../db/schema";
import type { WorkflowFormConfig } from "../../schemas/workflow-forms";
import { createWorkflowRun } from "./create-run";
import { validateFormSubmission } from "./validate-form-submission";

export type FormSubmitOutcome =
  | { ok: true; runId: string; workflowId: string }
  | { ok: false; message: string };

/**
 * Handle one form submission (access + rate limits already enforced by the
 * handler): validate the values/files against the stored form config, then
 * create a `form`-triggered run seeded with the answers, with any uploads
 * attached so the agent reads them. Serves both the public `/f/<token>` page
 * and a member's cockpit test run (`isTest` — a draft/paused dry-run).
 */
export const submitWorkflowForm = async (params: {
  workflow: Workflow;
  form: WorkflowFormConfig;
  values: Record<string, unknown>;
  files: Map<string, File[]>;
  triggeredByUserId?: string | null;
  isTest?: boolean;
}): Promise<FormSubmitOutcome> => {
  const validated = await validateFormSubmission({
    form: params.form,
    values: params.values,
    files: params.files,
  });
  if (!validated.ok) return { ok: false, message: validated.message };

  const run = await createWorkflowRun({
    workflow: params.workflow,
    triggerType: "form",
    triggerPayload: validated.payload,
    triggeredByUserId: params.triggeredByUserId ?? null,
    attachments: validated.attachments,
    isTest: params.isTest ?? false,
  });
  return { ok: true, runId: run.id, workflowId: run.workflowId };
};
