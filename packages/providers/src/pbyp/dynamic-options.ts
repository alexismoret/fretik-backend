import {
  arr,
  asNumber,
  asString,
  prop,
  str,
} from "@fretik/shared/external-apps/json-access";
import type {
  DynamicOptionsResult,
  ProviderDynamicOptions,
} from "@fretik/shared/external-apps/provider-types";
import { pbypFetch } from "./api";

/**
 * The profile dropdown in the connection modal.
 *
 * Pbyp is not merely multi-tenant, it is multi-tenant PER ACCOUNT: one
 * person routinely holds several profiles — an agency of the forwarder,
 * plus a client company they administer — and the whole access model keys
 * off whichever one is active (`directus_users.current_entities`, written
 * only by `POST /auth-endpoints/profile/:id`). A connection made without
 * choosing would inherit whatever profile the user last clicked in the
 * Pbyp UI, and would silently change scope the next time they clicked
 * another. So the choice is part of the credentials, and `on-connected.ts`
 * makes it real on Pbyp's side.
 *
 * The label carries the entity and the role ("Fibertex — Admin") because
 * the modal prefills the connection's display name from it, which is what
 * makes two Pbyp connections on one account tellable apart. Nothing else
 * rides along: the provider declares no `connectionOptions`, so an option's
 * `meta` would be projected nowhere (see the note in `manifest.ts`).
 */
export const pbypDynamicOptions: ProviderDynamicOptions = {
  listProfiles: async ({ credentials }): Promise<DynamicOptionsResult> => {
    const apiKey = asString(credentials.api_key);
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error("API key is missing");
    }

    const me = await pbypFetch(apiKey, "/users/me?fields=id");
    const userId = asString(prop(me, "id"));
    if (userId === undefined) {
      throw new Error(
        "Pbyp accepted the key but did not identify the account it belongs to.",
      );
    }

    const raw = await pbypFetch(
      apiKey,
      `/items/profiles?limit=50&fields=id,entity_id.id,entity_id.name,entity_id.is_client,role_id.name&filter[user_id][_eq]=${encodeURIComponent(userId)}`,
    );

    const options: DynamicOptionsResult["options"] = [];
    for (const profile of arr(raw)) {
      const id = asNumber(prop(profile, "id"));
      if (id === undefined) continue;
      const entity = prop(profile, "entity_id");
      const entityName = str(prop(entity, "name"), `Entity ${id.toString()}`);
      const role = asString(prop(prop(profile, "role_id"), "name"));
      options.push({
        value: id.toString(),
        label: role === undefined ? entityName : `${entityName} — ${role}`,
      });
    }

    if (options.length === 0) {
      throw new Error(
        "This Pbyp account has no profile yet. An administrator has to grant it access to an entity before it can be connected.",
      );
    }

    return { options };
  },
};
