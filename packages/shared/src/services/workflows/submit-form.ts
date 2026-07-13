import type { Workflow } from "../../db/schema";
import type { WorkflowFormConfig } from "../../schemas/workflow-forms";
import { createWorkflowRun } from "./create-run";
import { validateFormSubmission } from "./validate-form-submission";

export type FormSubmitOutcome = { ok: true } | { ok: false; message: string };

/**
 * Handle one public form submission (access + rate limits already enforced by
 * the handler): validate the values/files against the stored form config, then
 * create a `form`-triggered run seeded with the answers, with any uploads
 * attached so the agent reads them.
 */
export const submitPublicForm = async (params: {
  workflow: Workflow;
  form: WorkflowFormConfig;
  values: Record<string, unknown>;
  files: Map<string, File[]>;
  triggeredByUserId?: string | null;
}): Promise<FormSubmitOutcome> => {
  const validated = await validateFormSubmission({
    form: params.form,
    values: params.values,
    files: params.files,
  });
  if (!validated.ok) return { ok: false, message: validated.message };

  await createWorkflowRun({
    workflow: params.workflow,
    triggerType: "form",
    triggerPayload: validated.payload,
    triggeredByUserId: params.triggeredByUserId ?? null,
    attachments: validated.attachments,
  });
  return { ok: true };
};
