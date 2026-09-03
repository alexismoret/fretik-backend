import type {
  DynamicOptionsResult,
  ProviderDynamicOptions,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Resolvers for `dynamic-select` fields declared in the Shiptify
 * credentialsForm. Today: one handler — `listAccounts` — which the form
 * calls right after the user pastes their API key to populate the
 * Account dropdown.
 *
 * No persistence happens here; the dispatcher hands us the in-progress
 * form values and we fire `fetch()` against Shiptify directly (Nango
 * doesn't know this provider). Same egress assumptions as
 * `test-connection.ts`: `Authorization: <api_key>` verbatim, base URL
 * hardcoded.
 *
 * WHY THIS PROBES. `/accounts/` answers "accounts this user can SEE",
 * which is not "accounts this token may ACT ON". On a carrier-group
 * token the two differ wildly — measured on a real key: 18 accounts
 * listed, 1 accepted as `X-Account-ID`, the other 17 answering
 * `403 "Account is not available"` on every subsequent call. Offering
 * the raw list is therefore offering 17 ways to build a connection that
 * can never work, and the user only finds out at the first action. So
 * each candidate is probed, and only the ones that answer are offered.
 *
 * The list always leads with the empty value — no `X-Account-ID` at all,
 * the token's own scope. That is the widest option and the right default:
 * a group token narrowed to one account stops seeing the other accounts'
 * shipments entirely.
 */
const SHIPTIFY_BASE_URL = "https://api.shiptify.com";

/**
 * Probing costs one request per account. Beyond this many, offer the raw
 * list instead of making the user wait on a form field — a token with
 * that many accounts is a tenant-wide one, whose accounts are usually all
 * legitimate anyway.
 */
const MAX_PROBED_ACCOUNTS = 60;
const PROBE_CONCURRENCY = 8;

const previewBody = (raw: string): string =>
  raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;

interface ShiptifyAccount {
  id: number;
  name: string;
  type: "shipper" | "carrier" | null;
}

const parseAccounts = (raw: unknown): ShiptifyAccount[] => {
  if (!Array.isArray(raw)) return [];
  const out: ShiptifyAccount[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== "number") continue;
    const type =
      row.type === "shipper" || row.type === "carrier" ? row.type : null;
    out.push({
      id,
      name: typeof row.name === "string" ? row.name : `Account ${id}`,
      type,
    });
  }
  return out;
};

/**
 * Does the token accept this account as its `X-Account-ID`? `/accounts/`
 * is the cheapest authenticated call and applies the same account guard
 * as every other route, so a 2xx here means every later call will pass it
 * too. Any network failure counts as "keep it" — hiding a usable account
 * because one probe timed out is worse than offering one that 403s later.
 */
const acceptsAccount = async (
  apiKey: string,
  accountId: number,
): Promise<boolean> => {
  try {
    const res = await fetch(`${SHIPTIFY_BASE_URL}/accounts/`, {
      method: "GET",
      headers: { Authorization: apiKey, "X-Account-ID": accountId.toString() },
    });
    return res.ok;
  } catch {
    return true;
  }
};

const filterUsable = async (
  apiKey: string,
  accounts: ShiptifyAccount[],
): Promise<ShiptifyAccount[]> => {
  if (accounts.length > MAX_PROBED_ACCOUNTS) return accounts;
  const usable: ShiptifyAccount[] = [];
  for (let i = 0; i < accounts.length; i += PROBE_CONCURRENCY) {
    const batch = accounts.slice(i, i + PROBE_CONCURRENCY);
    const verdicts = await Promise.all(
      batch.map(async (a) => acceptsAccount(apiKey, a.id)),
    );
    batch.forEach((a, idx) => {
      if (verdicts[idx] === true) usable.push(a);
    });
  }
  return usable;
};

/** The role shared by every account the token sees, or null if mixed. */
const commonRole = (
  accounts: ShiptifyAccount[],
): "shipper" | "carrier" | null => {
  const roles = new Set<"shipper" | "carrier">();
  for (const account of accounts) {
    if (account.type !== null) roles.add(account.type);
  }
  if (roles.size !== 1) return null;
  return roles.has("shipper") ? "shipper" : "carrier";
};

export const shiptifyDynamicOptions: ProviderDynamicOptions = {
  listAccounts: async ({ credentials }): Promise<DynamicOptionsResult> => {
    const apiKey = credentials.api_key;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error("API key is missing");
    }

    let res: Response;
    try {
      res = await fetch(`${SHIPTIFY_BASE_URL}/accounts/`, {
        method: "GET",
        headers: { Authorization: apiKey },
      });
    } catch (error) {
      throw new Error(
        `Could not reach Shiptify: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Shiptify rejected the API key (${res.status.toString()}). Paste the token exactly as Shiptify shows it, including any prefix before the value.`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Shiptify returned ${res.status.toString()}: ${previewBody(body)}`,
      );
    }

    const accounts = parseAccounts(await res.json().catch(() => null));
    const usable = await filterUsable(apiKey, accounts);

    // The "every account" entry is always first and always valid — a token
    // that accepts no narrowing at all still connects through it.
    const role = commonRole(accounts);
    const options: DynamicOptionsResult["options"] = [
      {
        value: "",
        label: "Every account this key can reach",
        labelKey:
          "settings.externalApps.providers.shiptify.fields.account_id.allAccounts",
        ...(role !== null ? { meta: { account_type: role } } : {}),
      },
    ];
    for (const account of usable) {
      options.push({
        value: account.id.toString(),
        label:
          account.type !== null
            ? `${account.name} (${account.type})`
            : account.name,
        // Projected by the modal into `connectionOptions.account_type`, so
        // the agent learns the connection's role without being asked.
        ...(account.type !== null
          ? { meta: { account_type: account.type } }
          : {}),
      });
    }
    return { options };
  },
};
