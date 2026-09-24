import { loadPrincipal } from "../../authz/load-principal";
import { requireSharingAudience } from "../../authz/sharing-policy";
import { forbidden, throwHttpError } from "../../lib/errors";
import {
  type Audience,
  audienceReach,
  type RecordSharing,
} from "../../schemas/collection-sharing";

/**
 * The organization's sharing policies, for a collection's or a record's
 * audience as it is about to be written (`authz/sharing-policy.ts`): how far
 * it may reach, beyond the team or to the whole organization. The API, the
 * assistant's tools and the code-mode SDK all ask here before they write, so
 * turning a policy off closes every door at once.
 *
 * A caller with no person behind it (a team workflow) is the team, which
 * vouches for itself, as in the other collection checks.
 */

const personOf = async (input: { userId: string; organizationId: string }) => {
  const principal = await loadPrincipal(input);
  return (
    principal ??
    throwHttpError(403, forbidden("Not a member of this organization"))
  );
};

/** A collection's audience, created or changed. */
export const requireCollectionAudienceAllowed = async (input: {
  userId: string | undefined;
  organizationId: string;
  teamId: string;
  sharing: Audience | undefined;
}): Promise<void> => {
  if (input.sharing === undefined || input.userId === undefined) return;
  await requireSharingAudience({
    principal: await personOf({
      userId: input.userId,
      organizationId: input.organizationId,
    }),
    resourceTeamId: input.teamId,
    audience: audienceReach(input.sharing, input.teamId),
  });
};

/** A record's own audience (one that no longer follows its collection's). */
export const requireRecordAudienceAllowed = async (input: {
  userId: string | undefined;
  organizationId: string;
  teamId: string;
  sharing: RecordSharing | undefined;
}): Promise<void> => {
  if (input.sharing === undefined || input.sharing.inherit) return;
  await requireCollectionAudienceAllowed({
    ...input,
    sharing: input.sharing.audience,
  });
};
