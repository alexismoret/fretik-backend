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
    | "date"
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
        "date",
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
  /**
   * When true, the header is SKIPPED if its source is absent or empty,
   * instead of failing the call.
   *
   * Use it for a selector the API treats as a NARROWING filter rather than
   * as part of the credential: omitting it means "the credential's natural
   * scope", and sending a value the credential is not entitled to is an
   * outright rejection. Such a selector must be omissible, or every
   * connection is forced to guess one. Leave it off (the default) for a
   * header the API genuinely requires on every request.
   */
  optional: z.boolean().optional(),
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

/**
 * How many of this provider's calls may be in flight AT ONCE on ONE connection.
 *
 * `parallel` is the default and costs nothing — the slot is not taken, no Redis
 * is touched. `serial` exists for an API where a call is not self-contained:
 * Akanea WMS leases a LICENCE SEAT per action (`GetToken` … `ReleaseToken`), so
 * six page widgets loading together ask for six seats and the ones past the
 * pool's size come back with no token — indistinguishable, on the wire, from
 * wrong credentials.
 *
 * Named for what is bounded rather than for the symptom. `async: false` would
 * read as "this API is synchronous", which is not the property: the calls are
 * perfectly asynchronous, they just cannot OVERLAP on one account.
 */
export const providerConcurrencySchema = z.object({
  mode: z.enum(["parallel", "serial"]).default("parallel"),
  /**
   * How long a call waits for the connection to free up before giving up. Long
   * enough to absorb a page's fan-out, short enough that a stuck holder costs
   * one widget a message rather than the whole render.
   */
  maxWaitMs: z.number().int().min(0).max(60_000).default(8_000),
});
export type ProviderConcurrency = z.infer<typeof providerConcurrencySchema>;

/** A budget of `requests` calls per `perSeconds`, with an optional burst. */
export const rateBudgetSchema = z.object({
  requests: z.number().int().min(1).max(100_000),
  perSeconds: z.number().int().min(1).max(86_400),
  /**
   * How many may land back-to-back before the pacing bites. Defaults to the
   * whole allowance, which is what an API that publishes "600/min" means: 600
   * at once is within the budget, 601 is not.
   */
  burst: z.number().int().min(1).max(100_000).optional(),
});
export type RateBudget = z.infer<typeof rateBudgetSchema>;

/**
 * What this app can take, as the app itself publishes it.
 *
 * Declared here rather than discovered, because discovery means learning it
 * from a 429 — and a 429 is already a request someone lost. It is optional in
 * every part: most APIs are generous enough that the process-wide default
 * (`EXTERNAL_APP_DEFAULT_RATE_PER_MINUTE`) is the right answer, and a limit
 * invented to look thorough would throttle a provider nobody measured.
 *
 * Two scopes because the ceilings are genuinely two different ceilings, and a
 * single one would be wrong in both directions:
 *
 *  - `perConnection` is per ACCOUNT. Almost every published limit is this one
 *    ("600 requests per minute per API key"), and it must not be shared: one
 *    team's fan-out has no business slowing another team's.
 *  - `perProvider` is shared by EVERY connection of this provider in this
 *    deployment. It is what an API limiting by IP means, and it is what the
 *    Nango account limit means — that one applies to every proxied call we
 *    make, all teams together, so no per-account budget can express it.
 *
 * `maxConcurrent` is the other axis: how many calls may be IN FLIGHT at once on
 * one connection, which is what a licence-seat pool bounds (Akanea WMS leases a
 * seat per action) and what no request-per-second budget can say.
 */
export const providerRateLimitSchema = z.object({
  perConnection: rateBudgetSchema.optional(),
  perProvider: rateBudgetSchema.optional(),
  maxConcurrent: z.number().int().min(1).max(64).optional(),
  /**
   * The header this API answers a 429 with, when it is not `Retry-After`.
   * Nango's own provider config carries the same idea (`retry.after` /
   * `retry.at`) for the same reason: the NAME varies, the meaning does not.
   */
  retryAfterHeader: z.string().min(1).max(64).optional(),
});
export type ProviderRateLimit = z.infer<typeof providerRateLimitSchema>;

/**
 * How a READ action is walked past its first answer.
 *
 * It exists because pagination here is genuinely not uniform and never was
 * declared anywhere a machine could read: Front returns cursor pages
 * (`{page: X}` + `page_token`), most providers take `limit`/`offset`, Planner
 * and SharePoint set `paginate: true` and are walked server-side by the proxy,
 * and Akanea has no paging at all and says so in prose. A collection sync has
 * to pull EVERY row, so it needs that fact as data rather than as a convention
 * in an action's name.
 *
 * Absent, the walker infers: `returns: {page}` → cursor with `page_token`,
 * `paginate: true` → already whole, anything else → one call. Declaring it is
 * how a provider corrects a wrong inference, never how it invents a capability
 * the API lacks.
 */
export const actionPaginationSchema = z.object({
  kind: z.enum([
    /** `page_token` in, `page_token` out. */
    "cursor",
    /** `limit` + `offset`, where the offset counts ROWS. */
    "offset",
    /**
     * `limit` + a 1-based PAGE INDEX. Not a dialect of `offset`: Directus'
     * `page` is `1` for the first page where an offset is `0`, so walking one
     * as the other either skips the first page or re-reads it forever. Pbyp is
     * the case, and it is why this kind exists rather than a cast.
     */
    "page-number",
    /** The executor already returns every page (`paginate: true`). */
    "auto",
    /** One call is all there is. Narrow the filter instead. */
    "none",
  ]),
  /** Param carrying the page size. Defaults to `limit`. */
  limitParam: z.string().optional(),
  /** Largest page size the API accepts — asking for more is an error, not a cap. */
  maxLimit: z.number().int().positive().optional(),
  /** `cursor` only — param carrying the token. Defaults to `page_token`. */
  tokenParam: z.string().optional(),
  /** `cursor` only — key of the next token in the answer. Defaults to `page_token`. */
  tokenPath: z.string().optional(),
  /** `offset` only — param carrying the offset. Defaults to `offset`. */
  offsetParam: z.string().optional(),
  /** `page-number` only — param carrying the index. Defaults to `page`. */
  pageParam: z.string().optional(),
});
export type ActionPagination = z.infer<typeof actionPaginationSchema>;

/**
 * This read accepts SEVERAL ids in one call.
 *
 * The one declaration that turns a per-row refresh from N calls into N/max.
 * Only `ftp-sftp.get_entries` qualifies today; Outlook's `$batch` writes and
 * Pbyp's `query_items(filter: {id: {_in: […]}})` are the obvious next two.
 * Declaring it is a promise about the ANSWER too: the rows must come back in a
 * shape the caller can re-key by id, or batching silently mixes records up.
 */
export const actionBatchSchema = z.object({
  /** Param taking the id list. */
  param: z.string().min(1),
  /** Ids per call. */
  maxItems: z.number().int().min(2).max(500),
});
export type ActionBatch = z.infer<typeof actionBatchSchema>;

/**
 * This read can be bounded to what changed since a timestamp.
 *
 * What turns an hourly full pull into a delta — Front's `updated_after`,
 * Shiptify's `created_date_from`. The sync binds the source's own
 * `lastSuccessAt` to it, and DROPS the key on the first run so the seeding
 * pass sees everything.
 */
export const actionIncrementalSchema = z.object({
  /** Param taking the lower bound. */
  param: z.string().min(1),
  /** Wire format the API expects for it. */
  format: z.enum(["iso", "date", "epoch-seconds", "epoch-millis"]),
});
export type ActionIncremental = z.infer<typeof actionIncrementalSchema>;

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
   * Follow OData `@odata.nextLink` and aggregate every page's `value[]`
   * before the response mapper runs (`nango-proxy` only). Set on collection
   * reads of APIs that page server-side — notably Microsoft Graph Planner,
   * which caps task lists at ~400/page, so an un-paginated read silently
   * drops everything past the first page. Leave off for single-object reads
   * and intentionally-bounded lists (e.g. Outlook `$top`).
   */
  paginate: z.boolean().optional(),
  /**
   * Name of a handler function in the provider's `handlers` module
   * (`custom-handler` transport only). The handler receives
   * `(args, ctx: { credentials, connection_config })` and returns the
   * action's result.
   */
  handler: z.string().optional(),
  /**
   * Read-only capability declarations, consumed by the collection-sync walker
   * (`services/collection-sync/walk-read.ts`). None of them changes how the
   * agent calls the action, and the SDK/SKILL generator ignores all three — a
   * manifest that declares nothing behaves exactly as it did.
   */
  pagination: actionPaginationSchema.optional(),
  batch: actionBatchSchema.optional(),
  incremental: actionIncrementalSchema.optional(),
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
   * Multi-line secret or free text. Same storage as `password`; the
   * difference is that the value legitimately contains newlines, so a
   * single-line `<input>` mangles it on paste. The one case today is an
   * SSH private key — a PEM block is 5 to 50 lines and pasting it into a
   * one-line field is how users end up with a key that "looks right" and
   * never parses.
   */
  "textarea",
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
     * Render this field only while another field of the same form holds one
     * of these values. A hidden field is not rendered, not validated, and
     * not submitted — so `required: true` on a hidden field costs nothing,
     * which is the point: it is how a form expresses "required, but only for
     * this kind of connection".
     *
     * `ftp-sftp` is the case it exists for, three times over: a password is
     * required with password auth and meaningless with key auth, a private
     * key is the reverse, and a certificate override belongs to FTPS alone.
     * Showing all of them at once asks every user to reason about a protocol
     * they did not choose; splitting the provider in two (Pipedream ships
     * one app per SFTP auth method) asks them to choose an app by their
     * credential type.
     *
     * Deliberately one field against a value list — not an expression
     * language. Every real case is "this control belongs to that choice",
     * and a descriptor the frontend has to evaluate is a descriptor the
     * frontend and the backend can disagree about.
     */
    visibleWhen: z
      .object({
        /** Key of another field in the SAME descriptor. */
        field: z.string().min(1),
        /** Visible while that field's value is one of these. */
        equals: z.array(z.string().min(1)).min(1),
      })
      .optional(),
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

/**
 * Pack EVERY `target: "credentials"` field into ONE Nango credential field,
 * as a JSON object, instead of mapping them one-to-one.
 *
 * Nango's credential endpoints are strict and narrow, and that is the whole
 * reason this exists: `BASIC` accepts exactly `{ username, password }` with
 * each capped at 1024 characters, `API_KEY` exactly `{ apiKey }`. A provider
 * needing a third secret has nowhere to put it, and one needing a LONG secret
 * has nowhere to put it either — an RSA-2048 private key is ~1.7 KB and an
 * RSA-4096 one ~3.3 KB, so `ftp-sftp` fails both caps at once (username +
 * password + private key + passphrase).
 *
 * `connection_config` is not the answer: Nango encrypts `credentials` and
 * only `credentials` (`encryptConnection` in its `EncryptionManager`), so a
 * private key parked there would sit in plaintext in Nango's database.
 *
 * So the whole secret set travels as one JSON string in the `apiKey` slot of
 * the `private-api-bearer` template — one encrypted blob, arbitrary keys.
 * The frontend packs it at connect + reconnect time;
 * `normalizeNangoCredentials` unpacks it on read, so every downstream
 * consumer (handlers, `testCredentials`, the http-direct executor) keeps
 * reading flat `credentials.<field key>` and never learns this happened.
 *
 * **The envelope is wide, not unbounded: 4096 characters.** That is the
 * `apiKey` cap from Nango v0.71.6 onwards (commit `7cb48cd8`, 2026-09-01;
 * it was 1024 before, so the envelope needs an instance at least that new).
 * Past it Nango refuses the save with `invalid_body` / `too_big` on `apiKey`,
 * and its frontend SDK drops the part of that body naming the field — so a
 * provider whose secrets can approach 4096 characters must say what fits in
 * its SETUP.md; see `providers/src/ftp-sftp/SETUP.md` §2.
 *
 * Only reach for it when a provider genuinely exceeds Nango's slots.
 * `nangoKey` per field stays the right tool for a plain rename.
 */
export const credentialsSecretEnvelopeSchema = z.object({
  /**
   * The Nango credential field carrying the packed JSON. `apiKey` for the
   * `private-api-bearer` / `private-api-generic` templates (`API_KEY` auth
   * mode), which is the only slot wide enough to hold a private key.
   */
  nangoKey: z.string().min(1),
});
export type CredentialsSecretEnvelope = z.infer<
  typeof credentialsSecretEnvelopeSchema
>;

export const credentialsFormDescriptorSchema = z
  .object({
    /** Optional grouped sections (e.g. `imap`, `smtp`) for UI grouping. */
    sections: z
      .array(
        z.object({
          key: z.string(),
          titleKey: z.string(),
          /**
           * When true, the frontend renders this section collapsed behind a
           * "show advanced options" toggle. Use for optional override / fallback
           * fields the typical user never touches (auto-resolved server URL,
           * version, alternate login) so the default form stays minimal.
           */
          collapsed: z.boolean().optional(),
        }),
      )
      .optional(),
    fields: z.array(credentialFieldSchema).min(1),
    /** Mirror toggles between fields. */
    linkedFields: z.array(credentialLinkedFieldSchema).optional(),
    /**
     * Store every credentials-targeted field as ONE encrypted JSON blob —
     * see `credentialsSecretEnvelopeSchema`. Omit unless the provider needs
     * more (or longer) secrets than Nango's templates expose.
     */
    secretEnvelope: credentialsSecretEnvelopeSchema.optional(),
    testConnection: z.object({
      /** When true, the frontend renders a "Test connection" button. The */
      /** provider entry MUST then expose a `testCredentials` function. */
      supported: z.boolean(),
    }),
  })
  .superRefine((descriptor, ctx) => {
    const keys = new Set(descriptor.fields.map((field) => field.key));
    for (const field of descriptor.fields) {
      // A `visibleWhen` pointing at a key that is not in the form never
      // matches, so the field is invisible forever — and the form silently
      // loses a credential rather than failing loudly at boot.
      const condition = field.visibleWhen;
      if (condition !== undefined) {
        if (!keys.has(condition.field)) {
          ctx.addIssue({
            code: "custom",
            message: `field "${field.key}" is visibleWhen "${condition.field}", which is not a field of this form`,
          });
        }
        if (condition.field === field.key) {
          ctx.addIssue({
            code: "custom",
            message: `field "${field.key}" cannot gate its own visibility`,
          });
        }
      }

      // The envelope IS the rename: every secret lands under its own `key`
      // inside the JSON, so a per-field `nangoKey` on a credentials field says
      // two contradictory things about where that value goes.
      if (
        descriptor.secretEnvelope !== undefined &&
        field.target === "credentials" &&
        field.nangoKey !== undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: `field "${field.key}" declares nangoKey but the form uses a secretEnvelope — the envelope key is the only Nango-side name`,
        });
      }
    }
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
    /**
     * One-line, agent-facing summary of what this app does — becomes the
     * generated `SKILL.md` front-matter `description`, which the skill
     * catalogue reads for discovery (`materialize.ts`). Say what the app
     * IS and what the agent can do with it, so the agent knows when to
     * reach for it. Optional; falls back to `displayName` when absent.
     */
    description: z.string().min(1).optional(),
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
     * Optional brand RAMP (2–4 hex stops) painted across a monochrome
     * Iconify glyph instead of the flat `iconColor`. Ignored when `icon` is
     * an asset path — an SVG already carries its own colours.
     *
     * It exists for the marks whose identity IS the ramp: SharePoint's
     * `#036C70 → #1A9BA1 → #37C6D0` is what Microsoft publishes as the
     * logo, and a single flat teal reads as a different product. Most
     * brands are one colour and should keep `iconColor` alone.
     *
     * `iconColor` stays REQUIRED alongside it: it is the flat fallback and
     * the value the soft container tint is derived from, so a renderer that
     * ignores gradients still shows a correctly-branded icon.
     */
    iconGradient: z
      .array(
        z
          .string()
          .regex(
            /^#[0-9A-Fa-f]{6}$/,
            "iconGradient stops must be hex colors like #036C70",
          ),
      )
      .min(2)
      .max(4)
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
     * Omit for `parallel` — the default, and the one that costs nothing.
     *
     * @deprecated Superseded by `rateLimit.maxConcurrent`, which says the same
     * thing as a number instead of as a mode and can also say "three at a
     * time". Kept because three manifests and a connection-level override
     * (`external_app_connections.concurrency_mode`) still speak it, and the
     * governor reads `mode: "serial"` as `maxConcurrent: 1`.
     */
    concurrency: providerConcurrencySchema.optional(),
    /**
     * What this app can take. Omit unless the API publishes a number — see
     * `providerRateLimitSchema` for why an invented one is worse than none.
     */
    rateLimit: providerRateLimitSchema.optional(),
    /**
     * `true` when this app tells us something changed instead of waiting to be
     * asked — its webhook is relayed by Nango and a delivery brings the
     * connection's incremental sync sources forward
     * (`collection-sync/nudge-on-notify.ts`).
     *
     * DISPLAY ONLY, and nothing branches on it. It changes one sentence a team
     * reads about a source's cadence ("Once a day, and whenever <app> tells
     * us"), and that sentence is the whole value: a cadence the team believes
     * is what they judge the data by. The nudging itself is keyed on the
     * delivery arriving, not on this flag, so a `true` here with no webhook
     * registered upstream is a LIE to the user and not a broken sync — which is
     * why it may only be set once the operator has registered the integration's
     * webhook URL with the provider (`backend/docs/OPERATIONS.md`), and not
     * when the provider merely supports webhooks.
     */
    notifiesChanges: z.boolean().optional(),
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
     *    `wms`, `customs`, `shared-inbox`, …) — read by the agent from the system
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
    /** Named reusable collections referenced by `returns` / params. */
    types: z.record(z.string(), z.record(z.string(), paramSpecSchema)),
    actions: z.array(actionSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    // A gradient never stands alone: `iconColor` is the flat fallback and
    // the source of the soft container tint. Without it a renderer that
    // does not paint gradients falls back to `primary` and the provider
    // shows up unbranded.
    if (
      manifest.iconGradient !== undefined &&
      manifest.iconColor === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "iconGradient requires iconColor — it is the flat fallback and the container tint",
      });
    }

    const names = new Set<string>();
    for (const action of manifest.actions) {
      if (names.has(action.name)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate action name: ${action.name}`,
        });
      }
      names.add(action.name);

      // The three sync capabilities describe how a READ is walked, batched or
      // bounded. On a write they would describe nothing, and a reader that
      // believed them would page through a side effect.
      if (action.kind !== "read") {
        for (const capability of [
          "pagination",
          "batch",
          "incremental",
        ] as const) {
          if (action[capability] !== undefined) {
            ctx.addIssue({
              code: "custom",
              message: `action "${action.name}" declares \`${capability}\` but is a write — those describe how a read is walked`,
            });
          }
        }
      }

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
