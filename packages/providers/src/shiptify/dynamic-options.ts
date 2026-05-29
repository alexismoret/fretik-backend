import type { ProviderDynamicOptions } from "@fretik/shared/external-apps/provider-types";

/**
 * Resolvers for `dynamic-select` fields declared in the Shiptify
 * credentialsForm. Today: one handler — `listAccounts` — which the form
 * calls right after the user pastes their API key to populate the
 * Account dropdown.
 *
 * No persistence happens here; the dispatcher hands us the in-progress
 * form values and we fire `fetch()` against Shiptify directly (Nango
 * doesn't know this provider). The same egress assumptions as
 * `test-connection.ts` apply: `Authorization: <api_key>` header, base
 * URL hardcoded (no per-call override needed).
 */
const SHIPTIFY_BASE_URL = "https://api.shiptify.com";

const previewBody = (raw: string): string =>
  raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;

export const shiptifyDynamicOptions: ProviderDynamicOptions = {
  listAccounts: async ({ credentials }) => {
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
        `Shiptify rejected the API key (${res.status.toString()})`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Shiptify returned ${res.status.toString()}: ${previewBody(body)}`,
      );
    }

    const raw: unknown = await res.json().catch(() => null);
    if (!Array.isArray(raw)) {
      throw new Error("Shiptify /accounts/ returned an unexpected payload");
    }

    const options: Array<{
      value: string;
      label: string;
      meta?: Record<string, unknown>;
    }> = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== "number") continue;
      const name = typeof row.name === "string" ? row.name : `Account ${id}`;
      const type =
        typeof row.type === "string" &&
        (row.type === "shipper" || row.type === "carrier")
          ? row.type
          : null;
      const label = type !== null ? `${name} (${type})` : name;
      // `meta.account_type` flows through DynamicOptionsResult → the
      // frontend modal's `onDynamicSelectLabel` projects it into the
      // connectionOptions form, so the agent sees the right role without
      // the user having to re-pick it.
      const meta = type !== null ? { account_type: type } : undefined;
      options.push({ value: id.toString(), label, ...(meta ? { meta } : {}) });
    }
    return { options };
  },
};
