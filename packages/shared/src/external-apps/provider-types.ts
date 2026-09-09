import type { ToolApprovalSummaryField } from "../db/schema/approvals";

/**
 * Contracts a provider module contributes alongside its declarative
 * manifest: HTTP request/response transformers (nango-proxy transport),
 * action handlers (custom-handler transport), credentials tests, and
 * approval-card summaries.
 */

// ── Nango-proxy transport: request/response mappers ───────────────────

/**
 * A request that carries a binary, sent as `multipart/form-data` instead
 * of JSON. `http-direct` only — `buildRequest` refuses it on any other
 * transport rather than dropping it silently.
 *
 * It exists because some upload endpoints accept nothing else: Directus'
 * `POST /files` stores bytes from a multipart part and from no other
 * shape, so a provider that cannot speak multipart cannot put a document
 * into its customer's file store at all.
 */
export interface MultipartBody {
  /** Text parts sent alongside the file — columns on the created row. */
  fields?: Record<string, string>;
  /** The binary part. */
  file: {
    /** Form field name the API expects (Directus: `file`). */
    field: string;
    filename: string;
    contentType: string;
    /** The file's bytes, base64-encoded. */
    base64: string;
  };
}

/** Dynamic parts of a Nango Proxy request produced by a request mapper. */
export interface ProxyRequestParts {
  /** Overrides the (already path-substituted) manifest path when set. */
  endpoint?: string;
  /** Query-string parameters. */
  query?: Record<string, string>;
  /** JSON request body. */
  body?: unknown;
  /**
   * Binary request body. Mutually exclusive with `body` — the executor
   * builds a `FormData` and lets `fetch` set the boundary.
   */
  multipart?: MultipartBody;
  /**
   * Request headers. Most providers never need these — Nango injects auth.
   * Use for per-call headers the API mandates: Microsoft Planner requires
   * `If-Match: <etag>` on PATCH/DELETE (HTTP 412 otherwise).
   */
  headers?: Record<string, string>;
}

/**
 * Transforms an action's clean args into the dynamic parts of the HTTP
 * request (the method + base path come from the manifest endpoint).
 */
export type RequestMapper = (
  args: Record<string, unknown>,
) => ProxyRequestParts;

/**
 * Normalizes a raw provider response into the manifest's return shape.
 *
 * `args` are the SAME validated arguments the request mapper saw, handed
 * back so a response mapper can shape its output around what was asked —
 * filtering a catch-all endpoint down to the rows requested, for instance,
 * when the upstream API has no parameter for it.
 *
 * It exists so no provider has to stash that context in module state
 * between the two calls: a module-level slot is per-PROCESS, while the
 * concurrency slot that would make it safe is per-CONNECTION, so two
 * connections of the same provider in one process silently swap answers.
 */
export type ResponseMapper = (
  raw: unknown,
  args?: Record<string, unknown>,
) => unknown;

/** HTTP transformers a provider registers, keyed by mapper name. */
export interface ProviderMappers {
  request: Record<string, RequestMapper>;
  response: Record<string, ResponseMapper>;
}

// ── Custom-handler transport: action handlers & credentials tests ─────

/**
 * Context passed to a custom handler at dispatch time. Credentials and
 * connection_config are fetched from Nango via `nango.getConnection(...)`
 * just before the handler runs — Nango remains the single source of
 * truth for credential storage even though the protocol may not be HTTP.
 */
export interface ProviderHandlerContext {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
}

/**
 * A custom action handler. Returns the action's normalized result
 * (matching the manifest's `returns` shape). Errors should be thrown —
 * the dispatcher catches them and reports per-op `{ ok: false, error }`.
 */
export type ProviderHandler = (
  args: Record<string, unknown>,
  ctx: ProviderHandlerContext,
) => Promise<unknown>;

export type ProviderHandlers = Record<string, ProviderHandler>;

/**
 * Validates user-supplied credentials against the provider (e.g. an IMAP
 * LOGIN + SMTP STARTTLS verify, or a `GET /me` ping for an API). Used by
 * the "Test connection" button in the frontend AND by the post-create
 * verification inside `confirmConnection`. Returns a granular result so
 * the UI can tell the user which side failed.
 */
export type ProviderTestCredentials = (input: {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
}) => Promise<{ ok: true } | { ok: false; scope?: string; message: string }>;

/**
 * One-shot side effect run on the provider's side once a connection is
 * stored and its credentials verified — never on every call.
 *
 * It exists for an API where the credential alone does not fully determine
 * what the connection sees, and the missing part is SERVER-SIDE STATE the
 * user picked in our form. Pbyp is the case: a Directus account can hold
 * several profiles, and the effective scope
 * (`directus_users.current_entities`) is written only by
 * `POST /auth-endpoints/profile/:id`. Without this hook the connection
 * would silently keep whatever profile the account last used in the Pbyp
 * UI, and the selector in our modal would be decoration.
 *
 * Runs after `testCredentials` and only when that passed. A throw marks the
 * connection `status: "error"` with the message — the row is still created,
 * so the user can see and fix it, exactly like a failed credentials test.
 */
export type ProviderOnConnected = (input: {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
  /** Validated `connectionOptions`, when the manifest declares them. */
  options: Record<string, unknown> | null;
}) => Promise<void>;

/**
 * Resolver for a `dynamic-select` credential field. Receives the values
 * of the field's `dependsOn` dependencies (plus everything else the
 * user has already typed in the form, split by `target`) and returns
 * the option list the frontend should render. Used today by Shiptify's
 * `account_id` to fetch the user's allowed accounts from a freshly-pasted
 * API key, but reusable for any provider whose option set is personal to
 * the connecting user (Salesforce sandboxes, Stripe accounts, …).
 *
 * Implementations should:
 *  - throw with a clear message on auth failures (the dispatcher catches
 *    and surfaces it inline in the form),
 *  - return at most ~50 entries — the frontend renders them in a
 *    searchable dropdown, not a virtualized list.
 */
export interface DynamicOptionsResult {
  options: Array<{
    value: string;
    /** Label as returned by the provider. Used whenever `labelKey` is absent. */
    label: string;
    /**
     * i18n key the frontend renders instead of `label`. For the SYNTHETIC
     * entries a handler adds to a provider-sourced list — "all", "default",
     * "none" — which are our copy, not the provider's data, and therefore
     * have to be translated like every other displayed string. An option
     * carrying provider data leaves this unset.
     */
    labelKey?: string;
    /**
     * Optional per-option metadata. The frontend modal reads it when the
     * user picks an option and projects flagged keys into sibling form
     * fields — e.g. Shiptify's `listAccounts` returns `meta: {
     * account_type: "shipper" | "carrier" }` so the connectionOptions
     * `account_type` field auto-fills from the chosen `account_id`,
     * avoiding asking the user the same thing twice.
     */
    meta?: Record<string, unknown>;
  }>;
}

export type DynamicOptionsHandler = (input: {
  credentials: Record<string, unknown>;
  connection_config: Record<string, unknown>;
}) => Promise<DynamicOptionsResult>;

export type ProviderDynamicOptions = Record<string, DynamicOptionsHandler>;

// ── Approval-card summaries (every transport) ─────────────────────────

/** Per-operation block of an approval card, built by a summary mapper. */
export interface OperationSummaryPart {
  /**
   * i18n key suffix under `chatbot.approvals.<providerKey>.<action>.title`.
   * Pick a stable short identifier such as `default`, or a variant key when
   * one action needs several title phrasings.
   */
  titleKey: string;
  titleParams?: Record<string, string | number>;
  /** Detailed key/value rows shown under the title. */
  fields: ToolApprovalSummaryField[];
}

/** Builds the approval-card block for one write action. */
export type SummaryMapper = (
  args: Record<string, unknown>,
) => OperationSummaryPart;

/** Approval-card summary builders, keyed by action name. */
export type ProviderSummaries = Record<string, SummaryMapper>;
