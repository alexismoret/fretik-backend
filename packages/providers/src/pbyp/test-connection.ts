import { arr, asString, prop } from "@fretik/shared/external-apps/json-access";
import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";
import { PbypAuthError, pbypFetch, readProfileId } from "./api";

/**
 * Validate a Pbyp connection before it is used for anything.
 *
 * Three independent things can be wrong, and they send the user to three
 * different places, so the result names which one failed:
 *
 *  1. The key. A revoked or mistyped token answers 401/403.
 *  2. The profile. `profile_id` comes from a dropdown, but a form can be
 *     submitted after the account lost that profile — and a profile that
 *     is not the caller's is refused by Pbyp with a bare 404 later, at the
 *     first action, long after anyone would connect the two.
 *  3. The scope. A Pbyp account whose `current_entities` is empty is not
 *     broken in any way the API reports: every read simply returns an
 *     empty list. That is the failure mode most likely to be mistaken for
 *     "there is no data", so it is caught here, once, in words.
 */
export const testPbypCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  const apiKey = asString(credentials.api_key);
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, scope: "auth", message: "API key is missing" };
  }

  let me: unknown;
  try {
    me = await pbypFetch(
      apiKey,
      "/users/me?fields=id,email,current_entities,current_profile_id.id",
    );
  } catch (error) {
    if (error instanceof PbypAuthError) {
      return { ok: false, scope: "auth", message: error.message };
    }
    return {
      ok: false,
      scope: "network",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const userId = asString(prop(me, "id"));
  if (userId === undefined) {
    return {
      ok: false,
      scope: "auth",
      message: "Pbyp accepted the key but returned no account for it.",
    };
  }

  const profileId = readProfileId(connection_config.profile_id);
  if (profileId === undefined) {
    return {
      ok: false,
      scope: "profile",
      message: "Pick the Pbyp profile this connection should act under.",
    };
  }

  let profiles: unknown;
  try {
    profiles = await pbypFetch(
      apiKey,
      `/items/profiles?limit=1&fields=id&filter[id][_eq]=${profileId.toString()}&filter[user_id][_eq]=${encodeURIComponent(userId)}`,
    );
  } catch (error) {
    return {
      ok: false,
      scope: "profile",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  if (arr(profiles).length === 0) {
    return {
      ok: false,
      scope: "profile",
      message:
        "That profile does not belong to this Pbyp account any more. Reopen the list and pick one of the account's own profiles.",
    };
  }

  // Empty scope is a silent failure downstream — every query answers with
  // an empty list and nothing says why.
  const currentEntities = arr(prop(me, "current_entities"));
  if (currentEntities.length === 0 && prop(me, "current_profile_id") === null) {
    return {
      ok: false,
      scope: "scope",
      message:
        "This Pbyp account has no active scope yet. Open Pbyp once and select a profile, then test again.",
    };
  }

  return { ok: true };
};
