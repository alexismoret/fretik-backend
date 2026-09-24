import { getOrganizationAccessPolicy } from "../services/organization/access-policy";
import {
  type Capability,
  CAPABILITY_NAMES,
  type CapabilityDecision,
  decideCapability,
} from "./capabilities";
import type { Principal } from "./principal";
import { throwCapabilityRefusal } from "./refusals";

/**
 * Capabilities with the organization's policy read for the caller — the form
 * routes, tools and services use (`capabilities.ts` stays pure).
 */

const decide = async (input: {
  principal: Principal;
  capability: Capability;
  teamId?: string | null;
}): Promise<CapabilityDecision> => {
  if (input.principal.kind === "system") return { allowed: true };
  const policy = await getOrganizationAccessPolicy(
    input.principal.organizationId,
  );
  return decideCapability({ ...input, policy });
};

/** Whether the principal holds the capability, for a branch rather than a gate. */
export const hasCapability = async (input: {
  principal: Principal;
  capability: Capability;
  teamId?: string | null;
}): Promise<boolean> => (await decide(input)).allowed;

/**
 * Refuse unless the principal holds the capability: 403, with the reason and
 * whom to ask (the team's leads for a team capability, else the admins).
 */
export const requireCapability = async (input: {
  principal: Principal;
  capability: Capability;
  teamId?: string | null;
  message?: string;
}): Promise<void> => {
  const decision = await decide(input);
  if (decision.allowed || input.principal.kind === "system") return;
  return throwCapabilityRefusal({
    principal: input.principal,
    capability: input.capability,
    decision,
    teamId: input.teamId ?? null,
    message: input.message,
  });
};

/**
 * Every capability, decided for one person in one team — what the client
 * reads to show, hide or lock each action, so it never re-derives a rule.
 */
export const decideAllCapabilities = async (input: {
  principal: Principal;
  teamId: string | null;
}): Promise<Record<Capability, CapabilityDecision>> => {
  const policy =
    input.principal.kind === "system"
      ? null
      : await getOrganizationAccessPolicy(input.principal.organizationId);
  const decisions = {} as Record<Capability, CapabilityDecision>;
  for (const capability of CAPABILITY_NAMES) {
    decisions[capability] =
      policy === null
        ? { allowed: true }
        : decideCapability({
            principal: input.principal,
            capability,
            policy,
            teamId: input.teamId,
          });
  }
  return decisions;
};
