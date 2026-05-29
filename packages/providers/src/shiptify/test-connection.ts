import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";

/**
 * Validate user-supplied Shiptify credentials by pinging
 * `GET https://api.shiptify.com/accounts/` — the lightest authenticated
 * call available. We never call the provider via Nango here: the user
 * hasn't pushed credentials into Nango yet, so we hit the API directly
 * with the values from the form.
 *
 * Granular result lets the UI tell the user whether the failure is auth
 * (wrong API key), account (api key valid but account_id not in the
 * allowed list), or network (Shiptify unreachable).
 */
const SHIPTIFY_BASE_URL = "https://api.shiptify.com";

const previewBody = (raw: string): string =>
  raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;

export const testShiptifyCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  const apiKey = credentials.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return { ok: false, scope: "auth", message: "API key is missing" };
  }

  const accountIdRaw = connection_config.account_id;
  let accountId: number;
  if (typeof accountIdRaw === "number") {
    accountId = accountIdRaw;
  } else if (typeof accountIdRaw === "string" && accountIdRaw.length > 0) {
    const parsed = Number(accountIdRaw);
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        scope: "account",
        message: "Account id must be a number",
      };
    }
    accountId = parsed;
  } else {
    return { ok: false, scope: "account", message: "Account id is missing" };
  }

  let res: Response;
  try {
    res = await fetch(`${SHIPTIFY_BASE_URL}/accounts/`, {
      method: "GET",
      headers: {
        Authorization: apiKey,
        "X-Account-ID": String(accountId),
      },
    });
  } catch (error) {
    return {
      ok: false,
      scope: "network",
      message: error instanceof Error ? error.message : "Network error",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      scope: "auth",
      message: `Shiptify rejected the API key or the Account Id (${res.status.toString()})`,
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      scope: "auth",
      message: `Shiptify returned ${res.status.toString()}: ${previewBody(body)}`,
    };
  }

  // Optional cross-check: when the response is a JSON array of accounts,
  // ensure the supplied account_id appears in it. Shiptify's `/accounts/`
  // is documented as "Get allowed accounts for user" — surfacing a clear
  // mismatch now beats a 403 on every subsequent call.
  try {
    const raw: unknown = await res.json();
    if (Array.isArray(raw)) {
      const allowed = new Set<number>();
      for (const item of raw) {
        if (item !== null && typeof item === "object" && "id" in item) {
          const id: unknown = (item as Record<string, unknown>).id;
          if (typeof id === "number") allowed.add(id);
        }
      }
      if (allowed.size > 0 && !allowed.has(accountId)) {
        return {
          ok: false,
          scope: "account",
          message: `Account id ${accountId.toString()} is not in the allowed accounts for this API key`,
        };
      }
    }
  } catch {
    // Non-JSON response on /accounts/ — uncommon but not fatal; the auth
    // check already succeeded.
  }

  return { ok: true };
};
