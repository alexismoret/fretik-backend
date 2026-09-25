import { forbidden, throwHttpError } from "../lib/errors";
import { getOrganizationAccessPolicy } from "../services/organization/access-policy";
import {
  type Capability,
  CAPABILITY_NAMES,
  type CapabilityDecision,
  decideCapability,
} from "./capabilities";
import { loadPrincipal } from "./load-principal";
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
 * `requireCapability` for a service that holds a user id rather than a
 * principal — the collection write checks, the agent's tools. Loads the
 * principal (cached) and decides the same way; someone who is not a member of
 * the organization is refused outright.
 */
export const requireUserCapability = async (input: {
  userId: string;
  organizationId: string;
  capability: Capability;
  teamId?: string | null;
  message?: string;
}): Promise<void> => {
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!principal) {
    return throwHttpError(403, forbidden("Not a member of this organization"));
  }
  await requireCapability({
    principal,
    capability: input.capability,
    teamId: input.teamId,
    message: input.message,
  });
};

/** `hasCapability` for a caller that holds a user id rather than a principal. */
export const userHasCapability = async (input: {
  userId: string;
  organizationId: string;
  capability: Capability;
  teamId?: string | null;
}): Promise<boolean> => {
  const principal = await loadPrincipal({
    organizationId: input.organizationId,
    userId: input.userId,
  });
  if (!principal) return false;
  return hasCapability({
    principal,
    capability: input.capability,
    teamId: input.teamId,
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
