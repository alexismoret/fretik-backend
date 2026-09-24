import { legacyPrivacyWhere } from "../../authz/legacy-privacy";
import type { Principal } from "../../authz/principal";
import type { AccessLevel } from "../../schemas/access";

/**
 * Which workflows a principal reaches, and at what level — decided by the
 * access engine (`authz/`): the workflow's owner, its grants, and its
 * container (its project, else its team) unless it is restricted.
 *
 * A restricted workflow runs WITH ITS OWNER'S ACCESS (`create-run.ts`), so for
 * everyone but its owner it is capped at `view`: shown, never run nor
 * changed — anyone else doing so would act as the owner. Opening it to the
 * team makes it run as the team's agent instead, and lifts the cap.
 *
 * Every workflow service takes a PRINCIPAL. The internal callers that used to
 * omit it — the cron fire, the event sweep, the turn executor, run creation —
 * pass `systemPrincipal(reason)`: they resolved the workflow through a trusted
 * path (a trigger, a run row) and act for nobody in particular. There is no
 * admin widening: an organization admin reads a private workflow like anyone
 * else, through a grant.
 */
export const workflowAccessWhere = (principal: Principal, level: AccessLevel) =>
  legacyPrivacyWhere({
    principal,
    level,
    resourceType: "workflow",
    restrictedCeiling: "view",
  });
