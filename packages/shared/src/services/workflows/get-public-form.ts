import db from "../../db";
import type { Workflow } from "../../db/schema";
import type {
  PublicFormView,
  WorkflowFormConfig,
} from "../../schemas/workflow-forms";

/**
 * Build the public-safe form view served on `/f/<token>`: the form definition
 * plus the workflow/org/team display info the page header shows (including the
 * org logo for the header avatar). No run internals, no playbook, no owner
 * identity leak.
 */
export const serializePublicForm = async (
  workflow: Workflow,
  form: WorkflowFormConfig,
): Promise<PublicFormView> => {
  const [org, team] = await Promise.all([
    db.query.organization.findFirst({
      where: { id: workflow.organizationId },
      columns: { name: true, logo: true },
    }),
    db.query.team.findFirst({
      where: { id: workflow.teamId },
      columns: { name: true },
    }),
  ]);

  return {
    title: form.title,
    ...(form.description !== undefined
      ? { description: form.description }
      : {}),
    fields: form.fields,
    visibility: form.visibility,
    ...(form.submitLabel !== undefined
      ? { submitLabel: form.submitLabel }
      : {}),
    ...(form.successMessage !== undefined
      ? { successMessage: form.successMessage }
      : {}),
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    workflowIcon: workflow.icon,
    organizationName: org?.name ?? "",
    organizationLogo: org?.logo ?? null,
    teamName: team?.name ?? "",
  };
};
