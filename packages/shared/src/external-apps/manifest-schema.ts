import { z } from "zod";

/**
 * Provider manifest format — the single source of truth for one external
 * app (Outlook, Gmail, …). A manifest declares the provider's actions,
 * their parameters, their HTTP mapping and their return shapes.
 *
 * The manifest drives, deterministically and with no LLM in the loop:
 *  - the generated Python SDK (`fretik_apps/<provider>.py`, Pydantic models),
 *  - the generated `SKILL.md` reference section,
 *  - backend argument validation in the dispatcher,
 *  - the HTTP request the executor sends through the Nango Proxy.
 *
 * Manifests are authored as typed TS objects (`providers/<key>/manifest.ts`)
 * — type-checked at authoring time — and validated again at registry load
 * with the Zod schema below.
 */

/** Where a top-level parameter goes in the HTTP request. */
export const paramLocationSchema = z.enum(["path", "query", "body"]);
export type ParamLocation = z.infer<typeof paramLocationSchema>;

/**
 * Recursive parameter spec. `array.items` and `object.fields` nest the
 * same shape; nested specs never carry `in` (only top-level params map to
 * an HTTP location).
 */
export interface ParamSpec {
  type:
    | "string"
    | "integer"
    | "number"
    | "boolean"
    | "email"
    | "datetime"
    | "enum"
    | "array"
    | "object";
  /** Human description — surfaced in the SDK docstring and SKILL.md. */
  description?: string;
  /** Optional param (Pydantic `| None = None`, Zod `.optional()`). */
  optional?: boolean;
  /** Default value applied when the param is omitted. */
  default?: unknown;
  /**
   * Excluded from the plan's `lookupHash` — for volatile free-text fields
   * (message bodies) the agent may regenerate verbatim between runs.
   */
  excludeFromHash?: boolean;
  /** HTTP location — top-level params only. Defaults: read→query, write→body. */
  in?: ParamLocation;
  /** `enum` only — allowed string values. */
  values?: string[];
  /** `integer`/`number` only — inclusive bounds. */
  min?: number;
  max?: number;
  /** `array` only — element spec. */
  items?: ParamSpec;
  /** `object` only — named fields. */
  fields?: Record<string, ParamSpec>;
}

export const paramSpecSchema: z.ZodType<ParamSpec> = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "string",
        "integer",
        "number",
        "boolean",
        "email",
        "datetime",
        "enum",
        "array",
        "object",
      ]),
      description: z.string().optional(),
      optional: z.boolean().optional(),
      default: z.unknown().optional(),
      excludeFromHash: z.boolean().optional(),
      in: paramLocationSchema.optional(),
      values: z.array(z.string()).optional(),
      min: z.number().optional(),
      max: z.number().optional(),
      items: paramSpecSchema.optional(),
      fields: z.record(z.string(), paramSpecSchema).optional(),
    })
    .superRefine((spec, ctx) => {
      if (spec.type === "enum" && (!spec.values || spec.values.length === 0)) {
        ctx.addIssue({
          code: "custom",
          message: "enum param requires non-empty `values`",
        });
      }
      if (spec.type === "array" && !spec.items) {
        ctx.addIssue({
          code: "custom",
          message: "array param requires `items`",
        });
      }
      if (spec.type === "object" && !spec.fields) {
        ctx.addIssue({
          code: "custom",
          message: "object param requires `fields`",
        });
      }
    }),
);

/** HTTP method of an action's endpoint. */
export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

/**
 * Return shape of an action — drives the SDK return type and SKILL.md.
 *  - `{ ref }`     : a named type from the manifest's `types`.
 *  - `{ list }`    : an array of a named type.
 *  - `{ fields }`  : an inline anonymous object.
 *  - `{ void: true }` : no meaningful return (deletes, status flips).
 */
export const returnSpecSchema = z.union([
  z.object({ ref: z.string() }),
  z.object({ list: z.string() }),
  z.object({ fields: z.record(z.string(), paramSpecSchema) }),
  z.object({ void: z.literal(true) }),
]);
export type ReturnSpec = z.infer<typeof returnSpecSchema>;

export const actionSchema = z.object({
  /** Snake-case action name, unique within the provider, e.g. `send_email`. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "action name must be a snake_case slug"),
  /**
   * `read`  — auto-approved, executes immediately.
   * `write` — gated behind a user-approved plan.
   */
  kind: z.enum(["read", "write"]),
  /** One-line description (SDK docstring + SKILL.md reference line). */
  summary: z.string().min(1),
  endpoint: z.object({
    method: httpMethodSchema,
    /** May contain `{param}` placeholders filled from `in: "path"` params. */
    path: z.string().min(1),
  }),
  params: z.record(z.string(), paramSpecSchema),
  returns: returnSpecSchema,
  /**
   * Name of a request transformer in the provider's `mappers` module.
   * When absent, the generic executor places params by their `in` location.
   */
  request: z.string().optional(),
  /**
   * Name of a response transformer in the provider's `mappers` module.
   * When absent, the raw Nango Proxy response body is returned as-is.
   */
  response: z.string().optional(),
});
export type ManifestAction = z.infer<typeof actionSchema>;

export const providerManifestSchema = z
  .object({
    /** Lower-case provider key, e.g. `outlook`. */
    key: z.string().regex(/^[a-z][a-z0-9_]*$/),
    displayName: z.string().min(1),
    /** Integration ID configured in the Nango dashboard. */
    nangoProviderConfigKey: z.string().min(1),
    /** UIcon name for the provider logo, e.g. `i-simple-icons-microsoftoutlook`. */
    icon: z.string().min(1),
    /** OAuth scopes the Nango integration must request. */
    scopes: z.array(z.string()).min(1),
    /** Named reusable object types referenced by `returns` / params. */
    types: z.record(z.string(), z.record(z.string(), paramSpecSchema)),
    actions: z.array(actionSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const names = new Set<string>();
    for (const action of manifest.actions) {
      if (names.has(action.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate action name: ${action.name}`,
        });
      }
      names.add(action.name);
    }
  });
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
