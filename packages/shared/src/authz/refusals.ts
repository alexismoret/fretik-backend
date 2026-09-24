import { forbidden, notFound, throwHttpError } from "../lib/errors";
import type {
  AccessDenial,
  AccessDenialReason,
  AccessLevel,
  AccessResourceType,
} from "../schemas/access";
import { isRequestableResourceType } from "../schemas/access-sharing";
import { ERROR_CODES } from "../schemas/errors";
import type {
  Capability,
  CapabilityDecision,
  RequiredRole,
} from "./capabilities";
import { capabilityScope } from "./capabilities";
import { capabilityContacts, resourceContacts } from "./contacts";
import type { UserPrincipal } from "./principal";

/**
 * How the engine says no.
 *
 *   404 — the person cannot see the resource. It answers exactly like one
 *         that does not exist: its existence is itself what is protected.
 *   403 — they can see it (or the capability is visible to them) but may not
 *         do this. The body's `access` says why and whom to ask, so the client
 *         can explain the refusal and offer "Request access".
 *
 * `message` is an English fallback for logs and API clients; the app words
 * the refusal from `access.reason` in the reader's language.
 */

export const throwNotVisible = (message = "Resource not found"): never =>
  throwHttpError(404, notFound(message));

const LEVEL_NAMES: Record<AccessLevel, string> = {
  view: "view",
  use: "use",
  edit: "edit",
  full: "full",
};

/** Why a type gives someone no more than a level (`levelCeiling`). */
const LEVEL_CAP_MESSAGES: Partial<Record<AccessResourceType, string>> = {
  workflow:
    "A restricted workflow runs with its owner's access: only its owner runs or changes it.",
  conversation:
    "Only the people of this chat's project, or of its team when it is in no project, take part in it. You can read it.",
};

/** Why a refusal above a type's ceiling can't be lifted by sharing. */
export const levelCapMessage = (
  type: AccessResourceType,
  required: AccessLevel,
): string =>
  LEVEL_CAP_MESSAGES[type] ??
  `Nothing shared with you gives ${LEVEL_NAMES[required]} access to this.`;

const defaultResourceMessage = (
  type: AccessResourceType,
  reason: AccessDenialReason,
  required: AccessLevel,
  current: AccessLevel | null,
): string => {
  switch (reason) {
    case "INSUFFICIENT_LEVEL":
      return `This needs ${LEVEL_NAMES[required]} access; you have ${
        current === null ? "none" : LEVEL_NAMES[current]
      } access.`;
    case "GUEST_RESTRICTED":
      return "Guests can't do this.";
    case "LEVEL_CAP":
      return levelCapMessage(type, required);
    case "CANNOT_EXCEED_OWN":
      return "You can't give more access than you have.";
    case "ROLE_REQUIRED":
    case "POLICY_DISABLED":
      return "You don't have permission to do this.";
  }
};

/** Refuse an action on a resource the person can see. */
export const throwResourceRefusal = async (input: {
  principal: UserPrincipal;
  resource: {
    type: AccessResourceType;
    id: string;
    ownerUserId: string | null;
    teamId: string | null;
  };
  required: AccessLevel;
  current: AccessLevel | null;
  reason?: AccessDenialReason;
  message?: string;
}): Promise<never> => {
  const reason = input.reason ?? "INSUFFICIENT_LEVEL";
  const ask = await resourceContacts({
    organizationId: input.principal.organizationId,
    resourceType: input.resource.type,
    resourceId: input.resource.id,
    ownerUserId: input.resource.ownerUserId,
    teamId: input.resource.teamId,
    excludeUserId: input.principal.userId,
  });
  const access: AccessDenial = {
    reason,
    required: input.required,
    current: input.current,
    capability: null,
    requiredRole: null,
    resource: { type: input.resource.type, id: input.resource.id },
    ask,
    // Asking for more access makes sense when someone can give it to this
    // person through the share dialog; a guest limit, a type ceiling or a
    // collection (shared with teams, never one person) is not something
    // anyone can lift per person.
    requestable:
      reason === "INSUFFICIENT_LEVEL" &&
      ask.length > 0 &&
      !input.principal.isGuest &&
      isRequestableResourceType(input.resource.type),
  };
  return throwHttpError(403, {
    code: ERROR_CODES.ACCESS_DENIED,
    message:
      input.message ??
      defaultResourceMessage(
        input.resource.type,
        reason,
        input.required,
        input.current,
      ),
    access,
  });
};

/** Who a role refusal names: the people who hold the least role that reaches. */
const ROLE_HOLDERS: Record<RequiredRole, string> = {
  owner: "organization owners",
  admin: "organization admins",
  lead: "team leads",
  member: "the team's members and leads",
};

/**
 * `member` says the role rather than "members of the team": a viewer is in
 * the team, and would read that as already met.
 */
const ROLE_REFUSALS: Record<RequiredRole, string> = {
  owner: "Only organization owners can do this.",
  admin: "Only organization admins can do this.",
  lead: "Only team leads can do this.",
  member: "This needs the member role in the team.",
};

const defaultCapabilityMessage = (
  decision: Extract<CapabilityDecision, { allowed: false }>,
): string => {
  switch (decision.reason) {
    case "GUEST_RESTRICTED":
      return "Guests can't do this.";
    case "POLICY_DISABLED":
      return decision.requiredRole === null
        ? "Turned off by your administrator."
        : `Your administrator limited this to ${ROLE_HOLDERS[decision.requiredRole]}.`;
    case "ROLE_REQUIRED":
      return decision.requiredRole === null
        ? "You don't have permission to do this."
        : ROLE_REFUSALS[decision.requiredRole];
  }
};

/** Refuse a capability, naming who can change that. */
export const throwCapabilityRefusal = async (input: {
  principal: UserPrincipal;
  capability: Capability;
  decision: Extract<CapabilityDecision, { allowed: false }>;
  teamId: string | null;
  message?: string;
}): Promise<never> => {
  const ask =
    input.decision.reason === "GUEST_RESTRICTED"
      ? []
      : await capabilityContacts({
          organizationId: input.principal.organizationId,
          teamId:
            capabilityScope(input.capability) === "team" ? input.teamId : null,
          excludeUserId: input.principal.userId,
        });
  const access: AccessDenial = {
    reason: input.decision.reason,
    required: null,
    current: null,
    capability: input.capability,
    requiredRole: input.decision.requiredRole,
    resource: null,
    ask,
    requestable: input.decision.reason !== "GUEST_RESTRICTED" && ask.length > 0,
  };
  return throwHttpError(403, {
    code: ERROR_CODES.ACCESS_DENIED,
    message: input.message ?? defaultCapabilityMessage(input.decision),
    access,
  });
};

/** A refusal with no one to ask and nothing to request (system misuse). */
export const throwForbidden = (message: string): never =>
  throwHttpError(403, forbidden(message));
