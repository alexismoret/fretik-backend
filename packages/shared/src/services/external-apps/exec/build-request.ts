import type {
  ManifestAction,
  ParamSpec,
} from "../../../external-apps/manifest-schema";
import type { ResolvedAction } from "../../../external-apps/registry";
import type { NangoProxyCall } from "./nango-proxy";

/**
 * Turn a validated args object into a `NangoProxyCall`.
 *
 *  - Path params (`in: "path"`) are substituted into the manifest path.
 *  - If a request mapper is declared, it produces the dynamic
 *    query/body (and may even override the endpoint, e.g. when the
 *    target path varies with the args — `outlook.create_folder` with
 *    `parent_folder_id`).
 *  - Otherwise the generic placement runs: `in: "query"` → query;
 *    `in: "body"` → body; the default per-action kind decides where
 *    un-tagged params land (read → query, write → body).
 *
 * The provider config key + connection ID come from the caller — the
 * dispatcher resolves the connection per op.
 */

export interface BuiltRequest {
  method: NangoProxyCall["method"];
  endpoint: string;
  query?: Record<string, string>;
  body?: unknown;
}

const substitutePath = (
  template: string,
  args: Record<string, unknown>,
  params: Record<string, ParamSpec>,
): string => {
  let result = template;
  for (const [key, spec] of Object.entries(params)) {
    if (spec.in !== "path") continue;
    const value = args[key];
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`Missing path parameter "${key}"`);
    }
    result = result.replace(`{${key}}`, encodeURIComponent(String(value)));
  }
  return result;
};

const stringifyForQuery = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return value.toString();
  }
  return JSON.stringify(value);
};

const genericQuery = (
  args: Record<string, unknown>,
  action: ManifestAction,
): Record<string, string> | undefined => {
  const query: Record<string, string> = {};
  const defaultLocation: "query" | "body" =
    action.kind === "read" ? "query" : "body";
  for (const [key, spec] of Object.entries(action.params)) {
    if (spec.in === "path") continue;
    const location = spec.in ?? defaultLocation;
    if (location !== "query") continue;
    const value = args[key];
    if (value === undefined) continue;
    query[key] = stringifyForQuery(value);
  }
  return Object.keys(query).length > 0 ? query : undefined;
};

const genericBody = (
  args: Record<string, unknown>,
  action: ManifestAction,
): unknown => {
  const body: Record<string, unknown> = {};
  const defaultLocation: "query" | "body" =
    action.kind === "read" ? "query" : "body";
  for (const [key, spec] of Object.entries(action.params)) {
    if (spec.in === "path") continue;
    const location = spec.in ?? defaultLocation;
    if (location !== "body") continue;
    const value = args[key];
    if (value === undefined) continue;
    body[key] = value;
  }
  return Object.keys(body).length > 0 ? body : undefined;
};

export const buildRequest = (
  resolved: ResolvedAction,
  args: Record<string, unknown>,
): BuiltRequest => {
  const { action } = resolved;
  // buildRequest is reachable only from the nango-proxy branch of the
  // dispatcher; the registry enforces `endpoint` is present on every
  // nango-proxy action. The check below is a defense-in-depth narrowing
  // for the type system — it should be unreachable at runtime.
  if (action.endpoint === undefined) {
    throw new Error(
      `Action ${action.name} has no endpoint — buildRequest is reserved for nango-proxy transport`,
    );
  }
  const endpoint = substitutePath(action.endpoint.path, args, action.params);

  if (resolved.requestMapper !== undefined) {
    const parts = resolved.requestMapper(args);
    return {
      method: action.endpoint.method,
      endpoint: parts.endpoint ?? endpoint,
      query: parts.query,
      body: parts.body,
    };
  }

  return {
    method: action.endpoint.method,
    endpoint,
    query: genericQuery(args, action),
    body: genericBody(args, action),
  };
};
