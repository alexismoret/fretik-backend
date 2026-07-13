import type { ParamSpec } from "../../../external-apps/manifest-schema";

/**
 * Convert an MCP tool's JSON Schema (draft-07) into the manifest `ParamSpec`
 * shape the deterministic codegen consumes — so MCP-sourced descriptors feed
 * the SAME Python-stub emitter as hand-written manifests.
 *
 * JSON Schema is richer than `ParamSpec`; this maps the shapes that carry
 * cleanly (string/number/bool/enum/array/object) and collapses everything
 * else (`anyOf`, `additionalProperties`, `propertyNames`, missing `type`)
 * to `object` → `dict[str, Any]`. That is safe: the arguments are forwarded
 * verbatim to the MCP server, which validates against the real schema and
 * returns `isError` on mismatch — our stub only needs a callable signature.
 */

/** Fallback for any construct we don't map to a typed ParamSpec. */
const ANY_SPEC: ParamSpec = { type: "object", fields: {} };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asString = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

/** Pick the first non-null entry when `type` is a union array (`["string","null"]`). */
const primaryType = (node: Record<string, unknown>): string | undefined => {
  const t = node.type;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return t.find((x): x is string => typeof x === "string" && x !== "null");
  }
  return undefined;
};

const stringEnum = (node: Record<string, unknown>): string[] | undefined => {
  if (!Array.isArray(node.enum) || node.enum.length === 0) return undefined;
  if (!node.enum.every((v): v is string => typeof v === "string"))
    return undefined;
  return node.enum;
};

const withDescription = (
  spec: ParamSpec,
  node: Record<string, unknown>,
): ParamSpec => {
  const description = asString(node.description);
  return description !== undefined ? { ...spec, description } : spec;
};

const nodeToSpec = (raw: unknown): ParamSpec => {
  if (!isRecord(raw)) return ANY_SPEC;

  const values = stringEnum(raw);
  if (values !== undefined)
    return withDescription({ type: "enum", values }, raw);

  switch (primaryType(raw)) {
    case "string": {
      const format = asString(raw.format);
      if (format === "email") return withDescription({ type: "email" }, raw);
      if (format === "date-time")
        return withDescription({ type: "datetime" }, raw);
      return withDescription({ type: "string" }, raw);
    }
    case "integer":
      return withDescription({ type: "integer" }, raw);
    case "number":
      return withDescription({ type: "number" }, raw);
    case "boolean":
      return withDescription({ type: "boolean" }, raw);
    case "array":
      return withDescription(
        { type: "array", items: nodeToSpec(raw.items) },
        raw,
      );
    case "object": {
      const props = isRecord(raw.properties) ? raw.properties : undefined;
      const fields: Record<string, ParamSpec> = {};
      if (props !== undefined) {
        for (const [name, child] of Object.entries(props)) {
          fields[name] = nodeToSpec(child);
        }
      }
      return withDescription({ type: "object", fields }, raw);
    }
    default:
      // Missing `type`, `anyOf`/`oneOf`, etc. → opaque dict.
      return withDescription(ANY_SPEC, raw);
  }
};

/**
 * Convert a tool's top-level `inputSchema` into the `{ name: ParamSpec }` map
 * for the action. Non-`required` properties become `optional`. A default is
 * carried only for optional params, so codegen's required/optional ordering
 * (required first) stays aligned with the schema's `required` list.
 */
export const inputSchemaToParams = (
  inputSchema: Record<string, unknown> | undefined,
): Record<string, ParamSpec> => {
  if (inputSchema === undefined || !isRecord(inputSchema.properties)) return {};
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((v): v is string => typeof v === "string")
      : [],
  );

  const params: Record<string, ParamSpec> = {};
  for (const [name, child] of Object.entries(inputSchema.properties)) {
    const spec = nodeToSpec(child);
    params[name] = required.has(name) ? spec : { ...spec, optional: true };
  }
  return params;
};
