import { requireCapability } from "../../authz/gates";
import type { Principal } from "../../authz/principal";
import type {
  WorkflowAutonomy,
  WorkflowTriggerConfig,
  WorkflowTriggerType,
} from "../../schemas/workflows";

/**
 * The two workflow settings that are the TEAM's call, not the author's: a
 * workflow that acts without asking for approvals (`team.workflows.autonomous`)
 * and a form anyone with the link can fill (`share.public_link`). Both default
 * to every member (`schemas/access-policy.ts`), so this changes nothing until
 * an admin narrows them — and then it holds on every path that sets them:
 * the app, the assistant, activation.
 */

/** What a workflow is (or is about to be) set to. */
export interface WorkflowGovernedSettings {
  readonly autonomy: WorkflowAutonomy;
  readonly triggerType: WorkflowTriggerType;
  readonly triggerConfig: WorkflowTriggerConfig;
}

const isAutonomous = (settings: WorkflowGovernedSettings): boolean =>
  settings.autonomy === "autonomous";

const hasPublicForm = (settings: WorkflowGovernedSettings): boolean =>
  settings.triggerType === "form" &&
  settings.triggerConfig.form?.visibility === "public";

/**
 * Refuse settings the principal may not give the workflow. `before` is what
 * the workflow holds today, when it exists: a setting it already had is not
 * re-checked on an unrelated edit, so narrowing a policy does not lock people
 * out of workflows made before it — activation re-checks them all (`before`
 * omitted), which is when such a workflow would start acting.
 */
export const requireWorkflowSettingsAllowed = async (input: {
  principal: Principal;
  teamId: string;
  after: WorkflowGovernedSettings;
  before?: WorkflowGovernedSettings;
}): Promise<void> => {
  const { principal, teamId, after, before } = input;
  if (isAutonomous(after) && (before === undefined || !isAutonomous(before))) {
    await requireCapability({
      principal,
      capability: "team.workflows.autonomous",
      teamId,
    });
  }
  if (
    hasPublicForm(after) &&
    (before === undefined || !hasPublicForm(before))
  ) {
    await requireCapability({
      principal,
      capability: "share.public_link",
      teamId,
    });
  }
};
