import { z } from "zod";
import { isRecord } from "../../../external-apps/json-access";
import type {
  ManifestAction,
  ParamSpec,
} from "../../../external-apps/manifest-schema";

/**
 * Compile a manifest action's param specs into a Zod object schema, then
 * validate the agent's incoming args against it. Defense in depth on top
 * of the Pydantic models that already failed-fast in the sandbox SDK.
 *
 * Schemas are cached per action — the manifest is loaded once at boot.
 */

const cache = new Map<string, z.ZodTypeAny>();

const buildParamZod = (spec: ParamSpec): z.ZodTypeAny => {
  const base = buildBase(spec);
  let result = base;
  if (spec.default !== undefined) {
    result = result.optional().default(spec.default);
  } else if (spec.optional === true) {
    result = result.optional();
  }
  return result;
};

const buildBase = (spec: ParamSpec): z.ZodTypeAny => {
  switch (spec.type) {
    case "string":
      return z.string();
    case "integer": {
      let s = z.number().int();
      if (spec.min !== undefined) s = s.min(spec.min);
      if (spec.max !== undefined) s = s.max(spec.max);
      return s;
    }
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "email":
      return z.email();
    case "datetime":
      return z.iso.datetime({ offset: true });
    case "enum": {
      if (spec.values === undefined || spec.values.length === 0) {
        throw new Error("enum spec missing `values`");
      }
      return z.string().refine((v) => spec.values?.includes(v), {
        message: `must be one of: ${spec.values.join(", ")}`,
      });
    }
    case "array": {
      if (spec.items === undefined) {
        throw new Error("array spec missing `items`");
      }
      return z.array(buildParamZod(spec.items));
    }
    case "object": {
      if (spec.fields === undefined) {
        throw new Error("object spec missing `fields`");
      }
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, fieldSpec] of Object.entries(spec.fields)) {
        shape[key] = buildParamZod(fieldSpec);
      }
      return z.object(shape);
    }
    default: {
      // Exhaustiveness guard — every `ParamSpec.type` is handled above.
      const exhaustive: never = spec.type;
      throw new Error(`Unknown param type: ${String(exhaustive)}`);
    }
  }
};

const getActionSchema = (
  qualifiedName: string,
  action: ManifestAction,
): z.ZodTypeAny => {
  const cached = cache.get(qualifiedName);
  if (cached !== undefined) return cached;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, spec] of Object.entries(action.params)) {
    shape[key] = buildParamZod(spec);
  }
  const built = z.object(shape).strict();
  cache.set(qualifiedName, built);
  return built;
};

/**
 * Validate action args against the manifest. Throws `z.ZodError` on
 * failure — the caller turns it into `EXTERNAL_APP_PLAN_INVALID`.
 */
export const validateActionArgs = (
  qualifiedName: string,
  action: ManifestAction,
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const schema = getActionSchema(qualifiedName, action);
  const parsed: unknown = schema.parse(args);
  if (!isRecord(parsed)) {
    throw new Error("Validation produced a non-object value");
  }
  return parsed;
};
