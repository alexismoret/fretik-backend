import { resolveAccess } from "../../authz/access";
import { atLeast } from "../../authz/levels";
import { loadPrincipal } from "../../authz/load-principal";
import db from "../../db";
import type { Workflow } from "../../db/schema";
import type { WorkflowFormConfig } from "../../schemas/workflow-forms";

export type FormAccessResult =
  | {
      access: "ready";
      /** `live` = an active workflow (a real submission); `test` = a member
       * dry-running a draft/paused workflow through its own form. */
      mode: "live" | "test";
      workflow: Workflow;
      form: WorkflowFormConfig;
    }
  | { access: "not_found" }
  | { access: "inactive" }
  | { access: "login_required" }
  | { access: "forbidden" };

/**
 * Whether a signed-in person may open and fill a PRIVATE form. Filling one runs
 * the workflow, so it takes what running it takes in the app: `use` on the
 * workflow (`authz/`). A restricted workflow runs as its owner, so only they
 * may; a workflow open to its team, each member who may run it. Someone from
 * another organization is not in the workflow's, and reaches nothing.
 */
const canAccessPrivateForm = async (
  workflow: Workflow,
  userId: string,
): Promise<boolean> => {
  const principal = await loadPrincipal({
    organizationId: workflow.organizationId,
    userId,
  });
  if (!principal) return false;
  const resolved = await resolveAccess(principal, "workflow", workflow.id);
  return resolved !== null && atLeast(resolved.level, "use");
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

  // Not yet active → normally `inactive`, but a member with the workflow's own
  // scope may TEST-run a draft/paused form (the cockpit "Test" button opens
  // this page). Anonymous or out-of-scope visitors keep the `inactive` verdict;
  // archived is terminal (no test).
  if (workflow.status !== "active") {
    if (
      params.userId &&
      (workflow.status === "draft" || workflow.status === "paused") &&
      (await canAccessPrivateForm(workflow, params.userId))
    ) {
      return { access: "ready", mode: "test", workflow, form };
    }
    return { access: "inactive" };
  }

  if (form.visibility === "public") {
    return { access: "ready", mode: "live", workflow, form };
  }

  if (!params.userId) return { access: "login_required" };
  const allowed = await canAccessPrivateForm(workflow, params.userId);
  return allowed
    ? { access: "ready", mode: "live", workflow, form }
    : { access: "forbidden" };
};
