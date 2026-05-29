import { z } from "zod";

/**
 * Provider manifest format — the single source of truth for one external
 * app (Outlook, IMAP/SMTP, …). A manifest declares the provider's actions,
 * their parameters, their HTTP mapping (or custom handler) and their
 * return shapes.
 *
 * The manifest drives, deterministically and with no LLM in the loop:
 *  - the generated Python SDK (`fretik_apps/<provider>.py`, Pydantic models),
 *  - the generated `SKILL.md` reference section,
 *  - backend argument validation in the dispatcher,
 *  - the HTTP request the executor sends through the Nango Proxy, OR
 *  - the TypeScript handler invoked by the dispatcher for non-HTTP providers,
 *  - the credentials form rendered by the frontend (custom-handler providers).
 *
 * Manifests are authored as typed TS objects (`@fretik/providers/<key>/manifest.ts`)
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

/** HTTP method of an action's endpoint (`nango-proxy` transport only). */
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
 *  - `{ page }`    : a cursor-paginated page of a named type. The
 *                    generated SDK wraps the items in a `<X>Page` model
 *                    carrying `items: list[X]` and `page_token: str |
 *                    None`. The response mapper must return
 *                    `{ items: [...], page_token: string | undefined }`.
 *  - `{ fields }`  : an inline anonymous object.
 *  - `{ void: true }` : no meaningful return (deletes, status flips).
 */
export const returnSpecSchema = z.union([
  z.object({ ref: z.string() }),
  z.object({ list: z.string() }),
  z.object({ page: z.string() }),
  z.object({ fields: z.record(z.string(), paramSpecSchema) }),
  z.object({ void: z.literal(true) }),
]);
export type ReturnSpec = z.infer<typeof returnSpecSchema>;

/**
 * Provider transport — how the dispatcher executes actions.
 *
 *  - `nango-proxy`     : actions are HTTP REST calls through `nango.proxy(...)`.
 *                        Each action MUST have `endpoint: { method, path }`.
 *                        Optional `request` / `response` mappers reshape the
 *                        payload. Example: Outlook (Microsoft Graph).
 *  - `custom-handler`  : actions are arbitrary TS functions. Each action
 *                        MUST reference a `handler` exported from the
 *                        provider's `handlers` module. Credentials are
 *                        fetched from Nango via `nango.getConnection(...)`.
 *                        Used when the protocol is not HTTP (IMAP/SMTP) or
 *                        when the provider isn't on Nango (private OpenAPI,
 *                        SDK-only). Manifests of this kind generally also
 *                        declare a `credentialsForm` so the frontend can
 *                        render a custom form.
 *  - `http-direct`     : actions are HTTP REST calls executed via our own
 *                        `fetch()` (no Nango proxy). Same declarative
 *                        contract as `nango-proxy` (`endpoint`, `params`
 *                        with `in: path|query|body`, optional request /
 *                        response mappers) — the dispatcher reuses
 *                        `buildRequest()`. Used for HTTP APIs that are
 *                        NOT on Nango's catalog: a `credentialsForm`
 *                        collects API key / account id from the user,
 *                        Nango stores them via the `private-api-key`
 *                        template, and `auth` + `extraHeaders` describe
 *                        how to project those stored fields onto every
 *                        outgoing request.
 */
export const httpDirectSourceSchema = z
  .string()
  .regex(
    /^(credentials|connection_config)\.[a-z_][a-z0-9_]*$/,
    "source must be 'credentials.<key>' or 'connection_config.<key>'",
  );

export const httpDirectAuthSchema = z.object({
  /** Where to inject the credential value on every request. */
  kind: z.enum(["header", "query"]),
  /** Header name (e.g. "Authorization", "X-API-Key") or query param name. */
  name: z.string().min(1),
  /** Dot path into the stored connection (`credentials.api_key`, …). */
  source: httpDirectSourceSchema,
  /** Optional prefix prepended to the value (e.g. "Bearer "). */
  scheme: z.string().optional(),
});
export type HttpDirectAuthSpec = z.infer<typeof httpDirectAuthSchema>;

export const httpDirectExtraHeaderSchema = z.object({
  name: z.string().min(1),
  source: httpDirectSourceSchema,
});
export type HttpDirectExtraHeader = z.infer<typeof httpDirectExtraHeaderSchema>;

export const httpDirectTransportSchema = z.object({
  kind: z.literal("http-direct"),
  /** API root, e.g. "https://api.shiptify.com". No trailing slash. */
  baseUrl: z
    .string()
    .url()
    .refine((v) => !v.endsWith("/"), "baseUrl must not have a trailing slash"),
  /** Single auth credential injected on every call. */
  auth: httpDirectAuthSchema,
  /**
   * Static extra headers built from the stored connection (typical:
   * tenant / account selector that the API requires on every request).
   */
  extraHeaders: z.array(httpDirectExtraHeaderSchema).optional(),
});
export type HttpDirectTransport = z.infer<typeof httpDirectTransportSchema>;

export const providerTransportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nango-proxy") }),
  z.object({ kind: z.literal("custom-handler") }),
  httpDirectTransportSchema,
]);
export type ProviderTransport = z.infer<typeof providerTransportSchema>;

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
  /**
   * HTTP endpoint — required when the provider's transport is `nango-proxy`,
   * forbidden (or ignored) when `custom-handler`.
   */
  endpoint: z
    .object({
      method: httpMethodSchema,
      /** May contain `{param}` placeholders filled from `in: "path"` params. */
      path: z.string().min(1),
    })
    .optional(),
  params: z.record(z.string(), paramSpecSchema),
  returns: returnSpecSchema,
  /**
   * Name of a request transformer in the provider's `mappers` module
   * (`nango-proxy` only). When absent, the generic executor places params
   * by their `in` location.
   */
  request: z.string().optional(),
  /**
   * Name of a response transformer in the provider's `mappers` module
   * (`nango-proxy` only). When absent, the raw Nango Proxy response body is
   * returned as-is.
   */
  response: z.string().optional(),
  /**
   * Name of a handler function in the provider's `handlers` module
   * (`custom-handler` transport only). The handler receives
   * `(args, ctx: { credentials, connection_config })` and returns the
   * action's result.
   */
  handler: z.string().optional(),
});
export type ManifestAction = z.infer<typeof actionSchema>;

// ── Credentials form descriptor (custom-handler providers) ────────────
//
// Custom-handler providers render their own credentials form in the
// frontend `AddConnectionModal`. The descriptor below is a declarative
// schema the frontend reads (via `GET /external-apps/providers`) to
// dynamically render a `DynamicCredentialsForm.vue` with grouped sections
// and per-field validation. Adding a new credential field requires no
// frontend change.

export const credentialFieldKindSchema = z.enum([
  "text",
  "password",
  "email",
  "number",
  "boolean",
  "select",
  /**
   * Dropdown whose options are resolved at form-render time by calling a
   * provider-registered handler with the values of `dependsOn` fields
   * (typically a freshly-pasted API key). Used when the option set is
   * personal to the connecting user (a tenant id, an account number, a
   * sandbox name, …) and asking them to find it manually would be a
   * worse UX than a select that auto-populates.
   *
   * Field MUST declare `dependsOn` (non-empty) and `optionsHandler`. The
   * provider entry must register the handler under `dynamicOptions[<name>]`.
   * The dispatched call returns `{ options: Array<{ value, label }> }`.
   */
  "dynamic-select",
]);
export type CredentialFieldKind = z.infer<typeof credentialFieldKindSchema>;

/**
 * Where the field's value lands inside the Nango connection:
 *  - `credentials`        : encrypted secrets (e.g. password, API key).
 *  - `connection_config`  : non-secret provider-specific config (host, port,
 *                           region). Nango stores it next to the credentials
 *                           but does NOT treat it as a secret.
 */
export const credentialFieldTargetSchema = z.enum([
  "credentials",
  "connection_config",
]);
export type CredentialFieldTarget = z.infer<typeof credentialFieldTargetSchema>;

export const credentialFieldSchema = z
  .object({
    /** Stable identifier (snake_case), e.g. `imap_host`, `api_key`. */
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "field key must be a snake_case slug"),
    /** i18n key — frontend resolves via `t()`. */
    labelKey: z.string().min(1),
    /** Optional i18n key for help text / placeholder. */
    helpKey: z.string().optional(),
    kind: credentialFieldKindSchema,
    target: credentialFieldTargetSchema,
    required: z.boolean(),
    default: z.unknown().optional(),
    /** `select` only — options surfaced in the dropdown. */
    options: z
      .array(z.object({ value: z.string(), labelKey: z.string() }))
      .optional(),
    /** `integer`/`number` validators forwarded to the dynamic Zod schema. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** `text` validators — regex pattern forwarded to the dynamic Zod schema. */
    pattern: z.string().optional(),
    /**
     * Optional section the field belongs to (e.g. `imap`, `smtp`).
     * Matches a section `key` in `CredentialsFormDescriptor.sections`.
     */
    section: z.string().optional(),
    /**
     * `dynamic-select` only — keys of other fields in the same descriptor
     * that this select depends on. The frontend disables the field until
     * every dependency has a non-empty value, then debounce-calls the
     * options endpoint.
     */
    dependsOn: z.array(z.string().min(1)).optional(),
    /**
     * `dynamic-select` only — name of the handler in the provider's
     * `dynamicOptions` registry that resolves the option list at runtime.
     */
    optionsHandler: z.string().min(1).optional(),
    /**
     * Override for the field name used on the WIRE to Nango at connection
     * creation, AND for the name Nango uses when storing the field. Our
     * codebase convention is snake_case, but some Nango credential
     * templates expect a specific shape — e.g. `private-api-key` requires
     * `credentials.apiKey` (camelCase). Declare the Nango-side name here
     * when it differs from `key`; the frontend uses it when calling
     * `nango.auth(...)` and the backend normalises it back to `key` when
     * reading the stored connection.
     */
    nangoKey: z.string().min(1).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.kind === "dynamic-select") {
      if (field.dependsOn === undefined || field.dependsOn.length === 0) {
        ctx.addIssue({
          code: "custom",
          message:
            'dynamic-select field "' +
            field.key +
            '" must declare non-empty `dependsOn`',
        });
      }
      if (
        field.optionsHandler === undefined ||
        field.optionsHandler.length === 0
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            'dynamic-select field "' +
            field.key +
            '" must declare `optionsHandler`',
        });
      }
    } else {
      if (field.dependsOn !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            'field "' +
            field.key +
            '" has `dependsOn` but kind is not `dynamic-select`',
        });
      }
      if (field.optionsHandler !== undefined) {
        ctx.addIssue({
          code: "custom",
          message:
            'field "' +
            field.key +
            '" has `optionsHandler` but kind is not `dynamic-select`',
        });
      }
    }
  });
export type CredentialField = z.infer<typeof credentialFieldSchema>;

/**
 * UX helper for forms where one field can mirror another (e.g.
 * "use the IMAP password for SMTP"). The frontend renders a toggle that
 * copies `from` → `to` and disables the `to` input while active.
 */
export const credentialLinkedFieldSchema = z.object({
  /** Field key whose value is copied. */
  from: z.string(),
  /** Field key receiving the mirrored value. */
  to: z.string(),
  /** i18n key for the toggle label. */
  toggleLabelKey: z.string(),
  /** Whether the link is enabled by default. */
  defaultOn: z.boolean(),
});
export type CredentialLinkedField = z.infer<typeof credentialLinkedFieldSchema>;

export const credentialsFormDescriptorSchema = z.object({
  /** Optional grouped sections (e.g. `imap`, `smtp`) for UI grouping. */
  sections: z
    .array(z.object({ key: z.string(), titleKey: z.string() }))
    .optional(),
  fields: z.array(credentialFieldSchema).min(1),
  /** Mirror toggles between fields. */
  linkedFields: z.array(credentialLinkedFieldSchema).optional(),
  testConnection: z.object({
    /** When true, the frontend renders a "Test connection" button. The */
    /** provider entry MUST then expose a `testCredentials` function. */
    supported: z.boolean(),
  }),
});
export type CredentialsFormDescriptor = z.infer<
  typeof credentialsFormDescriptorSchema
>;

// ── Connection options descriptor ─────────────────────────────────────
//
// Per-provider runtime options that the user picks at connection time
// (or edits afterwards) — distinct from credentials. Examples: the
// `persona` of a communication account (personal vs bot), a default
// signature, an opt-in for some provider-specific behaviour. Stored as
// JSONB on `external_app_connections.options`, validated dynamically
// against the descriptor on POST/PATCH.
//
// The frontend renders the descriptor in `DynamicConnectionOptionsForm.vue`
// with one input per field, picking the widget from `kind`. Fields opted
// in with `exposeToAgent: true` are also surfaced to the chatbot in the
// system prompt's external_apps block, so the agent can adapt its
// behaviour per connection.

export const connectionOptionFieldKindSchema = z.enum([
  "boolean",
  "text",
  "textarea",
  "number",
  "select",
]);
export type ConnectionOptionFieldKind = z.infer<
  typeof connectionOptionFieldKindSchema
>;

export const connectionOptionFieldSchema = z
  .object({
    /** Stable identifier (snake_case), e.g. `persona`, `auto_reply`. */
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "field key must be a snake_case slug"),
    /** i18n key — frontend resolves via `t()`. */
    labelKey: z.string().min(1),
    /** Optional i18n key for help text / sub-label. */
    helpKey: z.string().optional(),
    kind: connectionOptionFieldKindSchema,
    required: z.boolean(),
    default: z.unknown().optional(),
    /** `select` only — options surfaced in the dropdown/radio. */
    options: z
      .array(
        z.object({
          value: z.string(),
          labelKey: z.string(),
          descriptionKey: z.string().optional(),
        }),
      )
      .optional(),
    /** `integer`/`number` validators forwarded to the dynamic Zod schema. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** `text` validators — regex pattern forwarded to the dynamic Zod schema. */
    pattern: z.string().optional(),
    /**
     * When true, this option's value is surfaced to the chatbot agent in the
     * system prompt's external_apps block (rendered as `key: value`). Use
     * sparingly — opt-in only for options that change the agent's behaviour.
     */
    exposeToAgent: z.boolean().default(false),
  })
  .superRefine((field, ctx) => {
    if (
      field.kind === "select" &&
      (!field.options || field.options.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "select option requires non-empty `options`",
      });
    }
  });
export type ConnectionOptionField = z.infer<typeof connectionOptionFieldSchema>;

export const connectionOptionsDescriptorSchema = z.object({
  fields: z.array(connectionOptionFieldSchema).min(1),
});
export type ConnectionOptionsDescriptor = z.infer<
  typeof connectionOptionsDescriptorSchema
>;

export const providerManifestSchema = z
  .object({
    /** Lower-case provider key, e.g. `outlook`. */
    key: z.string().regex(/^[a-z][a-z0-9-]*$/),
    displayName: z.string().min(1),
    /** Integration ID configured in the Nango dashboard. */
    nangoProviderConfigKey: z.string().min(1),
    /**
     * Provider logo. Two accepted forms:
     *  - Iconify name (e.g. `i-simple-icons-microsoftoutlook`) — monochrome,
     *    tinted by the frontend via `iconColor` if set, otherwise `primary`.
     *  - Absolute asset path starting with `/` (e.g. `/app-icons/slack.svg`) —
     *    rendered as an `<img>`, colors come from the SVG itself; `iconColor`
     *    is ignored.
     */
    icon: z.string().min(1),
    /**
     * Optional brand color (hex, e.g. `#0078D4`) used to tint monochrome
     * Iconify icons. Ignored when `icon` is an asset path.
     */
    iconColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/, "iconColor must be a hex color like #0078D4")
      .optional(),
    /**
     * OAuth scopes the Nango integration must request. Empty array
     * acceptable for `custom-handler` providers using Basic Auth on a
     * private integration (no OAuth flow).
     */
    scopes: z.array(z.string()),
    /** How the dispatcher executes this provider's actions. */
    transport: providerTransportSchema,
    /**
     * Frontend credentials form descriptor — required when the provider
     * uses a `custom-handler` transport (since the frontend cannot rely
     * on the Nango Connect UI for OAuth flows in that case).
     */
    credentialsForm: credentialsFormDescriptorSchema.optional(),
    /**
     * Per-provider connection options the user picks at creation (and can
     * edit afterwards). Stored as JSONB on `external_app_connections.options`,
     * validated dynamically against this descriptor. Fields opted in with
     * `exposeToAgent: true` are surfaced to the chatbot in the system prompt.
     */
    connectionOptions: connectionOptionsDescriptorSchema.optional(),
    /**
     * Set to `true` when at least one scope on this provider typically
     * requires tenant admin consent (Microsoft Entra ID, Google Workspace
     * with admin-restricted scopes, …). Drives three UX paths:
     *  - The AddConnectionModal renders an "Install for the whole
     *    organization" toggle that forwards `prompt=consent` to the OAuth
     *    provider via Nango (Microsoft v2 rejects the legacy
     *    `prompt=admin_consent` with AADSTS901001 — `prompt=consent` plus
     *    the `.default` scope is what triggers the admin-consent UI).
     *  - The same modal surfaces a friendly inline alert when the OAuth
     *    callback returns an admin-consent failure (e.g. AADSTS65001 /
     *    AADSTS90094 on Microsoft).
     *  - The SKILL generator can append a short admin-consent reminder to
     *    the chatbot's guidance for this provider.
     */
    requiresAdminConsent: z.boolean().optional(),
    /**
     * Provider categories — drive frontend filtering and agent disambiguation.
     *
     * Convention (not enforced beyond the regex):
     *  - exactly ONE "root" category — used by the settings filter UI — picked
     *    from: `communication | productivity | crm | storage | payments |
     *    documents | design | industry`. Every provider MUST declare one; there
     *    is no "other" fallback.
     *  - 0..N "fine" categories (`email`, `instant-messaging`, `sms`, `voice`,
     *    `video-call`, `calendar`, `contacts`, `file-storage`, `notes`,
     *    `database`, `tasks`, `e-signature`, `payments`, `design`, `tms`,
     *    `customs`, `shared-inbox`, …) — read by the agent from the system
     *    prompt to decide whether two connections are substitutable for one
     *    user request. The frontend ignores them.
     *
     * Examples:
     *  - outlook:    `["communication", "email", "calendar", "contacts"]`
     *  - imap-smtp:  `["communication", "email"]`
     *  - slack:      `["communication", "instant-messaging"]`
     *  - teams:      `["communication", "instant-messaging", "video-call", "calendar"]`
     *  - twilio:     `["communication", "sms", "voice"]`
     *  - front:      `["communication", "shared-inbox", "email"]`
     *  - notion:     `["productivity", "notes", "database", "tasks"]`
     *  - airtable:   `["productivity", "database"]`
     *  - onedrive:   `["storage", "file-storage"]`
     *  - stripe:     `["payments"]`
     *  - docusign:   `["documents", "e-signature"]`
     *  - canva:      `["design"]`
     *  - akanea:     `["industry", "tms", "customs"]`
     *  - shiptify:   `["industry", "tms"]`
     *  - salesforce: `["crm"]`
     */
    categories: z
      .array(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]*$/, "category must be a kebab-case slug"),
      )
      .min(1),
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

      // Transport-specific action requirements.
      // `nango-proxy` and `http-direct` both go through the declarative
      // HTTP pipeline (endpoint + params + mappers) — only the egress
      // differs.
      if (
        manifest.transport.kind === "nango-proxy" ||
        manifest.transport.kind === "http-direct"
      ) {
        if (action.endpoint === undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${manifest.transport.kind} provider action "${action.name}" must declare an endpoint`,
          });
        }
        if (action.handler !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `${manifest.transport.kind} provider action "${action.name}" must NOT declare a handler`,
          });
        }
      } else {
        if (action.handler === undefined || action.handler === "") {
          ctx.addIssue({
            code: "custom",
            message: `custom-handler provider action "${action.name}" must declare a handler`,
          });
        }
        if (action.endpoint !== undefined) {
          ctx.addIssue({
            code: "custom",
            message: `custom-handler provider action "${action.name}" must NOT declare an endpoint`,
          });
        }
      }
    }

    // Credentials form is reserved for transports where Fretik renders the
    // form itself (`custom-handler`, `http-direct`). The Nango Connect UI
    // handles OAuth (`nango-proxy`) natively, so a custom form would
    // duplicate it.
    if (
      manifest.transport.kind === "nango-proxy" &&
      manifest.credentialsForm !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "nango-proxy providers must NOT declare a credentialsForm (handled by Nango Connect UI)",
      });
    }
  });
export type ProviderManifest = z.infer<typeof providerManifestSchema>;
