import { APIError } from "better-auth/api";

/**
 * Better Auth's endpoints that change who belongs where, closed: Fretik's own
 * routes replace each one, decided by the access engine and journaled
 * (`services/access/record-event.ts`). Left open they were a second door,
 * never wider than ours (the organization's admins alone may use them) but
 * one that skipped the organization's policies and wrote no journal entry.
 *
 * Nothing of ours goes through them: the services write through Better
 * Auth's adapter (`lib/org-adapter.ts`), below the endpoints. What stays open
 * is what the app still calls: accepting and declining an invitation,
 * removing a team (its hooks withdraw its invitations and journal it), the
 * organization's own settings, and every read.
 */
const REPLACED_BY: Readonly<Record<string, string>> = {
  "/organization/invite-member":
    "POST /teams/{id}/invitations, or POST /access/resources/{type}/{id}/invitations",
  "/organization/cancel-invitation": "DELETE /members/invitations/{id}",
  "/organization/update-member-role": "PATCH /members/{userId}",
  "/organization/remove-member": "DELETE /members/{userId}",
  "/organization/create-team": "POST /teams",
  "/organization/update-team": "PATCH /teams/{id}",
  "/organization/add-team-member": "POST /teams/{id}/members",
  "/organization/remove-team-member": "DELETE /teams/{id}/members/{userId}",
};

/** The code a closed endpoint answers with, beside the route to use. */
export const ENDPOINT_REPLACED = "ENDPOINT_REPLACED";

/** Refuse a closed endpoint, naming what replaces it; any other passes. */
export const refuseReplacedEndpoint = (path: string): void => {
  const replacement = REPLACED_BY[path];
  if (replacement === undefined) return;
  throw new APIError("FORBIDDEN", {
    code: ENDPOINT_REPLACED,
    message: `This endpoint is closed. Use ${replacement}.`,
  });
};
