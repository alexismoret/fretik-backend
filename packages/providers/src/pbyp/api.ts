import { isRecord } from "@fretik/shared/external-apps/json-access";

/**
 * The little bit of HTTP the three connection-time modules share.
 *
 * They all run BEFORE anything is stored in Nango — the user has only
 * typed into a form — so they call Pbyp directly with the pasted key,
 * exactly like Shiptify's `test-connection.ts`. Once the connection
 * exists, every call goes through the generic http-direct executor
 * instead, and none of this is used.
 */

export const PBYP_BASE_URL = "https://directus.app.pbyp.fr";

const previewBody = (raw: string): string =>
  raw.length > 200 ? `${raw.slice(0, 200)}…` : raw;

export class PbypAuthError extends Error {}

/**
 * The profile id as the form stored it — a number, or the string a
 * `dynamic-select` produces. `undefined` when there is none.
 *
 * Not `Number(value ?? "")`: `Number("")` is 0, not NaN, so an absent
 * selection would read as profile 0 and be POSTed as a real id.
 */
export const readProfileId = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * One authenticated request. Throws `PbypAuthError` when Pbyp refuses the
 * key — the caller reports that as a credentials problem rather than as an
 * outage, because the two send the user to very different places.
 */
export const pbypFetch = async (
  apiKey: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> => {
  let res: Response;
  try {
    res = await fetch(`${PBYP_BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(init?.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new Error(
      `Could not reach Pbyp: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new PbypAuthError(
      `Pbyp rejected the API key (${res.status.toString()}). Generate a new one from Profile management → API key in Pbyp and paste it whole.`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Pbyp returned ${res.status.toString()} on ${path}: ${previewBody(text)}`,
    );
  }

  if (text.length === 0) return null;
  const parsed: unknown = JSON.parse(text);
  return isRecord(parsed) && "data" in parsed ? parsed.data : parsed;
};
