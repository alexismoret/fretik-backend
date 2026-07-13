import db from "../../db";
import type { Workflow } from "../../db/schema";
import type { WorkflowFormConfig } from "../../schemas/workflow-forms";
import { isOrgAdmin } from "../organization/member-role";
import { isTeamMember } from "../team/members";

export type FormAccessResult =
  | { access: "ready"; workflow: Workflow; form: WorkflowFormConfig }
  | { access: "not_found" }
  | { access: "inactive" }
  | { access: "login_required" }
  | { access: "forbidden" };

/**
 * Whether a signed-in user may view/fill a PRIVATE form: org admins (governance),
 * the owner of a user-scoped workflow, or any member of a team-shared one —
 * the same scope the authenticated app enforces, applied to the public page.
 */
const canAccessPrivateForm = async (
  workflow: Workflow,
  userId: string,
): Promise<boolean> => {
  if (await isOrgAdmin(workflow.organizationId, userId)) return true;
  if (workflow.userId) return workflow.userId === userId;
  return isTeamMember(workflow.teamId, userId);
};

/**
 * Resolve who may access the form behind a public token. Public forms are open
 * to anyone with the link; private forms fall back to the workflow's own scope
 * and need a session. `userId` is the signed-in user, if any (the handler
 * resolves it from the optional session — absent means anonymous). Returns the
 * workflow + form only on `ready`, so a forbidden caller learns nothing about a
 * private form's contents.
 */
export const resolveFormAccess = async (params: {
  token: string;
  userId?: string;
}): Promise<FormAccessResult> => {
  const workflow = await db.query.workflows.findFirst({
    where: { formToken: params.token },
  });
  if (!workflow) return { access: "not_found" };

  const form = workflow.triggerConfig.form;
  if (workflow.triggerType !== "form" || !form) return { access: "not_found" };
  if (workflow.status !== "active") return { access: "inactive" };

  if (form.visibility === "public") {
    return { access: "ready", workflow, form };
  }

  if (!params.userId) return { access: "login_required" };
  const allowed = await canAccessPrivateForm(workflow, params.userId);
  return allowed
    ? { access: "ready", workflow, form }
    : { access: "forbidden" };
};
