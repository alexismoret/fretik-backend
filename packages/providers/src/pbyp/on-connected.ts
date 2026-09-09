import { asString } from "@fretik/shared/external-apps/json-access";
import type { ProviderOnConnected } from "@fretik/shared/external-apps/provider-types";
import { pbypFetch, readProfileId } from "./api";

/**
 * Make the chosen profile the account's ACTIVE one, on Pbyp's side.
 *
 * `POST /auth-endpoints/profile/:id` is the only writer of
 * `directus_users.current_entities` — the value all six Pbyp Access
 * Policies read. Storing `profile_id` in the connection therefore proves
 * nothing on its own: without this call the API keeps answering under
 * whichever profile the account last used, and the selector in our modal
 * would be a label with no effect.
 *
 * Consequence worth knowing, and stated in the guidance: the active
 * profile is a property of the ACCOUNT, not of this connection. Activating
 * one here also changes what the person sees in their own Pbyp session,
 * and their switching profiles there changes what this connection sees.
 * That is Pbyp's model, not something we can paper over.
 */
export const pbypOnConnected: ProviderOnConnected = async ({
  credentials,
  connection_config,
}) => {
  const apiKey = asString(credentials.api_key);
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error("API key is missing");
  }

  const profileId = readProfileId(connection_config.profile_id);
  if (profileId === undefined) {
    throw new Error("No Pbyp profile was selected for this connection.");
  }

  await pbypFetch(apiKey, `/auth-endpoints/profile/${profileId.toString()}`, {
    method: "POST",
  });
};
