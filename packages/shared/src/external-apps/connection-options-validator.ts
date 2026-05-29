import { z } from "zod";
import type {
  ConnectionOptionField,
  ConnectionOptionsDescriptor,
} from "./manifest-schema";

/**
 * Build a Zod schema validating a connection's `options` JSONB against the
 * provider's declared `connectionOptions` descriptor. Used by the connection
 * POST/PATCH handlers to validate user-submitted options at the boundary,
 * and by the frontend dev-time as a reference for input widgets.
 *
 * Strategy:
 *  - Required fields → strict typing, no default applied here (default is a
 *    UX hint, not a server-side fallback — if the field is required, the
 *    client must send it).
 *  - Optional fields → wrapped in `.optional()`.
 *  - `select` → `z.enum([...values])`.
 *  - `boolean` / `text` / `textarea` / `number` → corresponding Zod primitive
 *    with min/max/pattern constraints when present.
 */
export const buildConnectionOptionsZod = (
  descriptor: ConnectionOptionsDescriptor,
): z.ZodType<Record<string, unknown>> => {
  const shape: Record<string, z.ZodType> = {};
  for (const field of descriptor.fields) {
    const base = buildFieldZod(field);
    shape[field.key] = field.required ? base : base.optional();
  }
  return z.object(shape).strict();
};

const buildFieldZod = (field: ConnectionOptionField): z.ZodType => {
  switch (field.kind) {
    case "boolean":
      return z.boolean();
    case "number": {
      let s = z.number();
      if (field.min !== undefined) s = s.min(field.min);
      if (field.max !== undefined) s = s.max(field.max);
      return s;
    }
    case "text":
    case "textarea": {
      let s = z.string();
      if (field.pattern !== undefined) s = s.regex(new RegExp(field.pattern));
      return s;
    }
    case "select": {
      const values = field.options?.map((o) => o.value) ?? [];
      if (values.length === 0) {
        throw new Error(
          `select field "${field.key}" has no options — manifest schema should have caught this`,
        );
      }
      return z.enum(values as [string, ...string[]]);
    }
  }
};
