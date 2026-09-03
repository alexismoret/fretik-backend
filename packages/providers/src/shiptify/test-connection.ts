import type { ProviderTestCredentials } from "@fretik/shared/external-apps/provider-types";

/**
 * Validate user-supplied Shiptify credentials against
 * `GET https://api.shiptify.com/accounts/` — the lightest authenticated
 * call available. Never through Nango: the user has not pushed anything
 * into Nango yet, so we hit the API directly with the form values.
 *
 * TWO calls, because there are two independent things to fail:
 *  1. WITHOUT `X-Account-ID` — is the API key itself accepted? This is the
 *     call the connection will make when no account is selected.
 *  2. WITH it, only when the user picked an account — may the key act on
 *     that account? Shiptify answers `403 "Account is not available"` when
 *     it may not, which is a configuration problem and NOT a bad key.
 *
 * Testing only the second call is what made a working key look revoked:
 * a 403 from the account guard was reported as "Shiptify rejected the API
 * key or the Account Id", sending users to regenerate a token that was
 * fine. Scope and message now name which of the two failed.
 */
const SHIPTIFY_BASE_URL = "https://api.shiptify.com";

const previewBody = (raw: string): string =>
  raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;

/** Shiptify's own wording when the account guard rejects the header. */
const ACCOUNT_NOT_AVAILABLE = "account is not available";

const ping = async (
  apiKey: string,
  accountId: number | null,
): Promise<Response | Error> => {
  try {
    return await fetch(`${SHIPTIFY_BASE_URL}/accounts/`, {
      method: "GET",
      headers: {
        Authorization: apiKey,
        ...(accountId !== null ? { "X-Account-ID": accountId.toString() } : {}),
      },
    });
  } catch (error) {
    return error instanceof Error ? error : new Error("Network error");
  }
};

export const testShiptifyCredentials: ProviderTestCredentials = async ({
  credentials,
  connection_config,
}) => {
  const apiKey = credentials.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return { ok: false, scope: "auth", message: "API key is missing" };
  }

  // `account_id` is optional — absent means "no narrowing", the widest and
  // recommended setup. Only a present-but-unparseable value is an error.
  const accountIdRaw = connection_config.account_id;
  let accountId: number | null = null;
  if (typeof accountIdRaw === "number") {
    accountId = accountIdRaw;
  } else if (typeof accountIdRaw === "string" && accountIdRaw !== "") {
    const parsed = Number(accountIdRaw);
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        scope: "account",
        message: "Account id must be a number",
      };
    }
    accountId = parsed;
  }

  // ── 1. The key on its own ──────────────────────────────────────────
  const keyRes = await ping(apiKey, null);
  if (keyRes instanceof Error) {
    return { ok: false, scope: "network", message: keyRes.message };
  }
  if (!keyRes.ok) {
    const body = await keyRes.text().catch(() => "");
    return {
      ok: false,
      scope: "auth",
      message:
        keyRes.status === 401 || keyRes.status === 403
          ? `Shiptify rejected the API key (${keyRes.status.toString()}). Paste the token exactly as Shiptify shows it, including any prefix before the value.`
          : `Shiptify returned ${keyRes.status.toString()}: ${previewBody(body)}`,
    };
  }
  if (accountId === null) return { ok: true };

  // ── 2. The key ON the chosen account ───────────────────────────────
  const accountRes = await ping(apiKey, accountId);
  if (accountRes instanceof Error) {
    return { ok: false, scope: "network", message: accountRes.message };
  }
  if (accountRes.ok) return { ok: true };

  const body = await accountRes.text().catch(() => "");
  if (body.toLowerCase().includes(ACCOUNT_NOT_AVAILABLE)) {
    return {
      ok: false,
      scope: "account",
      message: `The API key is valid, but it may not act on account ${accountId.toString()}. Pick another account, or leave the field empty to use every account the key can reach.`,
    };
  }
  return {
    ok: false,
    scope: "account",
    message: `Shiptify refused account ${accountId.toString()} (${accountRes.status.toString()}): ${previewBody(body)}`,
  };
};
