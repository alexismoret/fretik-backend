import {
  asString,
  isRecord,
  prop,
} from "@fretik/shared/external-apps/json-access";
import { assertPublicHttpsUrl } from "@fretik/shared/lib/net/assert-public-https-url";
import { field } from "./normalize";

/**
 * Xtent web-service client — connection config, license-token lease, and
 * one JSON POST helper shared by every handler.
 *
 * The token model is the reason this provider is a `custom-handler` rather
 * than `http-direct`: Xtent does not authenticate requests with a static
 * key. A call sequence must lease a token, use it, and RELEASE it —
 * `ReleaseToken` frees the license seat, and the vendor documentation is
 * explicit that skipping it can leave the customer locked out of their own
 * WMS. Every lease here is therefore wrapped in try/finally.
 */

const REQUEST_TIMEOUT_MS = 60_000;

export interface AkaneaConfig {
  /** API root, e.g. `https://xtent.example.com`. No trailing slash. */
  baseUrl: string;
  accessId: string;
  userId: string;
  password: string;
}

/** Which part of the round-trip failed — drives the "Test connection" UI. */
export type AkaneaErrorScope = "config" | "network" | "auth" | "protocol";

/**
 * Error carrying the HTTP status so the dispatcher's `isAuthFailure` can
 * tell a dead credential (401/403 — flip the connection to `error`) from a
 * business rejection or an exhausted license pool, which must stay
 * transient.
 */
export class AkaneaError extends Error {
  readonly status?: number;
  readonly scope: AkaneaErrorScope;

  constructor(
    message: string,
    scope: AkaneaErrorScope = "protocol",
    status?: number,
  ) {
    super(message);
    this.name = "AkaneaError";
    this.scope = scope;
    this.status = status;
  }
}

const requireString = (value: unknown, label: string): string => {
  const parsed = asString(value);
  if (parsed === undefined || parsed.trim().length === 0) {
    throw new AkaneaError(
      `Missing required Akanea WMS field: ${label}`,
      "config",
    );
  }
  return parsed.trim();
};

/**
 * Drop any query string, fragment and trailing slash the user pasted, so
 * `${baseUrl}/json/…` stays well-formed. The path is KEPT — an Xtent
 * instance may legitimately be published under one (`https://host/xtent`).
 */
const normalizeBaseUrl = (raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AkaneaError(
      `Akanea WMS server URL is not a valid URL: ${raw}`,
      "config",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

export const parseAkaneaConfig = (
  credentials: Record<string, unknown>,
  connectionConfig: Record<string, unknown>,
): AkaneaConfig => ({
  baseUrl: normalizeBaseUrl(
    requireString(prop(connectionConfig, "base_url"), "base_url"),
  ),
  accessId: requireString(prop(connectionConfig, "access_id"), "access_id"),
  userId: requireString(prop(credentials, "user_id"), "user_id"),
  password: requireString(prop(credentials, "password"), "password"),
});

const truncate = (raw: string, max = 400): string =>
  raw.length > max ? `${raw.slice(0, max)}…` : raw;

const decodeXmlEntities = (raw: string): string =>
  raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&amp;/g, "&");

/**
 * Markup bodies (WCF faults, IIS error pages) read as noise with tags —
 * and an IIS error page leads with a stylesheet, so its `<style>` block
 * has to go first or the "preview" is a wall of CSS.
 */
const previewBody = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("<")) return truncate(trimmed);
  const text = decodeXmlEntities(
    trimmed
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  return truncate(text);
};

const FAULT_REASON = /<Reason>\s*<Text[^>]*>([\s\S]*?)<\/Text>/i;

/**
 * Pull the human-readable reason out of a WCF fault.
 *
 * Xtent answers a bad filter with HTTP **200** and an XML `<Fault>` whose
 * `<Reason><Text>` carries the only actionable sentence — e.g. "Le filtre
 * n'est pas valide: No property or field 'Foo' exists in type 'EnItem'".
 * Left as a raw body it would be truncated markup, and the agent could not
 * repair its own filter.
 */
const faultMessage = (raw: string): string | undefined => {
  if (!raw.trim().startsWith("<")) return undefined;
  const match = FAULT_REASON.exec(raw);
  const reason = match?.[1];
  if (reason === undefined) return undefined;
  return truncate(decodeXmlEntities(reason).replace(/\s+/g, " ").trim());
};

/** Xtent wraps every payload in `{ "result": … }`. */
export const unwrapResult = (raw: unknown): unknown => {
  const result = field(raw, "result");
  return result === undefined ? raw : result;
};

/**
 * Pull the 26-character token out of `GetToken`'s response. The vendor
 * documents the value but not the envelope, and .NET hosts vary between a
 * bare JSON string and a collection key — accept both rather than guess.
 */
const extractToken = (raw: unknown): string | undefined => {
  const direct = asString(raw);
  if (direct !== undefined && direct.trim().length > 0) return direct.trim();
  if (!isRecord(raw)) return undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.toLowerCase().includes("token")) continue;
    const token = asString(value);
    if (token !== undefined && token.trim().length > 0) return token.trim();
  }
  const nested = unwrapResult(raw);
  return nested === raw ? undefined : extractToken(nested);
};

const readBody = async (response: Response): Promise<string> => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

const parseJson = (body: string, endpoint: string): unknown => {
  if (body.trim().length === 0) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new AkaneaError(
      `Akanea WMS returned a non-JSON response on ${endpoint}: ${previewBody(body)}`,
      "protocol",
    );
  }
};

const request = async (
  url: string,
  init: RequestInit,
  endpoint: string,
): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // `assertPublicHttpsUrl` validates the host we dial but delegates the
      // redirect vector to the caller: without this, a 302 from the
      // customer's server would walk our runtime to an internal address —
      // and `GetToken` carries the credentials in its query string.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "network error";
    throw new AkaneaError(
      `Could not reach Akanea WMS on ${endpoint}: ${reason}`,
      "network",
    );
  }

  const body = await readBody(response);
  const rejected = response.status === 401 || response.status === 403;

  // Checked before the status: Xtent returns its faults with HTTP 200.
  const fault = faultMessage(body);
  if (fault !== undefined) {
    throw new AkaneaError(
      `Akanea WMS rejected ${endpoint}: ${fault}`,
      rejected ? "auth" : "protocol",
      response.ok ? undefined : response.status,
    );
  }

  // A 404 here is the service saying the OPERATION is not published — the
  // path is fixed by us, so it is never a caller typo. Observed on a live
  // install for `IntegrationWebServices/Parties`, which that server simply
  // does not expose. Say so, rather than hand back an IIS error page.
  if (response.status === 404) {
    throw new AkaneaError(
      `Akanea WMS does not expose the ${endpoint} web service on this server. It is unavailable for this warehouse — the operation may not be published, or its integration flow may not be enabled for the stockeur.`,
      "protocol",
      404,
    );
  }

  if (!response.ok) {
    throw new AkaneaError(
      `Akanea WMS returned ${response.status.toString()} on ${endpoint}: ${previewBody(body)}`,
      rejected ? "auth" : "protocol",
      response.status,
    );
  }
  return parseJson(body, endpoint);
};

/** POST a JSON body to a Xtent web service, with the leased token injected. */
export type AkaneaCall = (
  path: string,
  body: Record<string, unknown>,
) => Promise<unknown>;

const getToken = async (config: AkaneaConfig): Promise<string> => {
  const url = new URL(`${config.baseUrl}/json/Login/GetToken`);
  url.searchParams.set("accessId", config.accessId);
  url.searchParams.set("userId", config.userId);
  url.searchParams.set("password", config.password);

  const raw = await request(
    url.toString(),
    { method: "GET" },
    "Login/GetToken",
  );
  const token = extractToken(raw);
  if (token === undefined) {
    // No HTTP status attached on purpose. Xtent answers 200 both when the
    // credentials are wrong AND when the license pool is saturated;
    // synthesising a 401 here would let `isAuthFailure` disable a perfectly
    // good connection the next time every seat happens to be taken.
    throw new AkaneaError(
      "Akanea WMS did not return a session token — check the access id, user and password, that web-service integration is enabled for this account, and that a licence seat is free.",
      "auth",
    );
  }
  return token;
};

const releaseToken = async (
  config: AkaneaConfig,
  token: string,
): Promise<void> => {
  const url = new URL(`${config.baseUrl}/json/Login/ReleaseToken`);
  url.searchParams.set("token", token);
  await request(url.toString(), { method: "GET" }, "Login/ReleaseToken");
};

/**
 * Lease a token, run `fn` with a ready-to-use call helper, and always
 * release the seat. A failed release is logged and swallowed: it must not
 * mask the caller's real error, but it also must never be skipped.
 */
export const withToken = async <T>(
  config: AkaneaConfig,
  fn: (call: AkaneaCall) => Promise<T>,
): Promise<T> => {
  await assertPublicHttpsUrl(config.baseUrl, { label: "Akanea WMS server" });

  const token = await getToken(config);
  try {
    const call: AkaneaCall = (path, body) =>
      request(
        `${config.baseUrl}/json/${path}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, ...body }),
        },
        path,
      );
    return await fn(call);
  } finally {
    try {
      await releaseToken(config, token);
    } catch (error) {
      console.warn(
        "[akanea-wms] ReleaseToken failed — the license seat stays held until Xtent times it out:",
        error instanceof Error ? error.message : error,
      );
    }
  }
};
