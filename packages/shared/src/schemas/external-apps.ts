import { z } from "@hono/zod-openapi";
import {
  externalAppConcurrencyModeEnum,
  externalAppConnectionStatusEnum,
  externalAppMcpAuthKindEnum,
} from "../db/schema/external-apps";
import {
  connectionOptionsDescriptorSchema,
  credentialsFormDescriptorSchema,
  providerTransportSchema,
} from "../external-apps/manifest-schema";
import { toolPolicyLevelSchema } from "./tool-policies";

/**
 * HTTP schemas for `/external-apps/*` routes — the provider catalogue and
 * per-tenant Nango connections.
 *
 * The wire shape is intentionally **distinct** from the DB row type
 * (`ExternalAppConnection`): we strip Nango-internal columns
 * (`nangoProviderConfigKey`) and surface a friendlier `scope` enum derived
 * from `userId IS NULL`.
 *
 * The provider catalogue (`GET /external-apps/providers`) is built from
 * the in-memory registry — no DB row, no manifest YAML on the wire.
 *
 * The generic approval schemas moved to `schemas/approvals.ts`; the
 * `/sandbox/exec` wire contract moved to `schemas/sandbox.ts`.
 */

// ============================================================================
// Provider catalogue (GET /external-apps/providers)
// ============================================================================

export const providerActionEntrySchema = z.object({
  name: z.string().openapi({
    example: "send_email",
    description: "Snake-case action name unique within the provider.",
  }),
  kind: z.enum(["read", "write"]).openapi({
    description:
      "Read actions execute immediately; write actions go through user approval.",
  }),
  summary: z.string().openapi({
    example: "Send a new email",
    description:
      "One-line description shown in the SDK docstring and SKILL.md.",
  }),
});
export type ProviderActionEntry = z.infer<typeof providerActionEntrySchema>;

export const providerCatalogEntrySchema = z.object({
  key: z.string().openapi({
    example: "outlook",
    description: "Stable lowercase provider identifier.",
  }),
  displayName: z.string().openapi({
    example: "Microsoft Outlook",
    description: "Human-friendly provider name (rendered in settings UI).",
  }),
  icon: z.string().openapi({
    example: "i-simple-icons-microsoftoutlook",
    description:
      "Iconify name (e.g. `i-simple-icons-microsoftoutlook`) or absolute asset path (e.g. `/app-icons/slack.svg`).",
  }),
  iconColor: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional()
    .openapi({
      example: "#0078D4",
      description:
        "Optional hex color tint applied to monochrome Iconify icons. Ignored for asset paths.",
    }),
  scopes: z.array(z.string()).openapi({
    description: "OAuth scopes the Nango integration must request.",
  }),
  // `transport`, `credentialsForm` and `connectionOptions` come from
  // `manifest-schema.ts`, which uses the vanilla `zod` import — they
  // don't have the `.openapi()` method patched in by `@hono/zod-openapi`.
  // OpenAPI doc for these fields is omitted; the runtime validation is
  // unaffected.
  transport: providerTransportSchema,
  credentialsForm: credentialsFormDescriptorSchema.optional(),
  connectionOptions: connectionOptionsDescriptorSchema.optional(),
  requiresAdminConsent: z.boolean().optional().openapi({
    description:
      "When true, the provider's OAuth scopes typically require tenant admin consent — the UI surfaces an 'Install for the whole organization' toggle on the connect modal.",
  }),
  categories: z.array(z.string()).openapi({
    description:
      "Provider categories. First slug is the root used by the frontend filter (e.g. `communication`, `productivity`, `crm`); subsequent slugs are fine-grained (e.g. `email`, `instant-messaging`, `calendar`).",
  }),
  actions: z.array(providerActionEntrySchema),
});
export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;

export const providersListResponseSchema = z.object({
  providers: z.array(providerCatalogEntrySchema),
});
export type ProvidersListResponse = z.infer<typeof providersListResponseSchema>;

// ============================================================================
// Connect session + connections (POST/GET/PATCH/DELETE /external-apps/...)
// ============================================================================

export const connectionScopeSchema = z.enum(["team", "user"]).openapi({
  description:
    'Visibility scope: "team" is shared with every member; "user" is private to the creator.',
});
export type ConnectionScope = z.infer<typeof connectionScopeSchema>;

export const connectSessionRequestSchema = z.object({
  providerKey: z.string().min(1).openapi({
    example: "outlook",
    description: "Provider key from `GET /external-apps/providers`.",
  }),
  /**
   * When true, the Nango Connect session forwards `prompt=consent` to the
   * OAuth provider (Microsoft Entra ID, Google Workspace) so a tenant
   * admin can grant the requested scopes for the whole organization in
   * one sign-in. Subsequent users in the same tenant then connect without
   * triggering an individual consent prompt. On Microsoft v2 the legacy
   * `prompt=admin_consent` value is invalid (AADSTS901001); `prompt=consent`
   * + the `.default` scope shows the admin consent UI when the signing-in
   * user is a tenant admin.
   */
  adminConsent: z.boolean().optional().openapi({
    description:
      "Forward `prompt=consent` to the OAuth provider so a tenant admin can grant scopes org-wide. Only meaningful for providers with `requiresAdminConsent: true`.",
  }),
  /**
   * The MCP server URL, already known to the caller (a hub-discovered app or a
   * custom entry). Pre-seeds the `mcp-generic` connection config so Nango's
   * Connect UI does not re-ask for a URL the user has effectively already
   * chosen. Ignored for every non-`mcp-generic` provider.
   */
  mcpServerUrl: z.string().min(1).optional().openapi({
    description:
      "Pre-seed the `mcp-generic` server URL so Connect UI doesn't re-prompt for it. Ignored for other providers.",
  }),
});
export type ConnectSessionRequest = z.infer<typeof connectSessionRequestSchema>;

export const connectSessionResponseSchema = z.object({
  token: z.string().openapi({
    description:
      "Short-lived Nango Connect session token for `nango-frontend`.",
  }),
  connectLink: z.string().openapi({
    description: "Hosted Connect URL — alternative to the embedded UI.",
  }),
  expiresAt: z.string().openapi({
    description: "ISO 8601 expiration timestamp for the session token.",
  }),
});
export type ConnectSessionResponse = z.infer<
  typeof connectSessionResponseSchema
>;

/**
 * Response shape of `GET /external-apps/connections/{id}/connection-config`.
 * Used by the frontend to pre-fill the credentials form when the user
 * clicks "Reconnect" on a `custom-handler` connection. Only the
 * non-sensitive fields (`target: 'connection_config'` in the provider's
 * descriptor) are present — credentials never leave Nango.
 */
export const connectionConfigResponseSchema = z.object({
  connectionConfig: z.record(z.string(), z.unknown()).openapi({
    description:
      "Non-sensitive connection_config values for descriptor-driven pre-fill on reconnect (IMAP/SMTP host/port, etc.). Empty object when no such fields exist for the provider.",
  }),
});
export type ConnectionConfigResponse = z.infer<
  typeof connectionConfigResponseSchema
>;

/**
 * MCP-specific confirm params for a custom server. `serverUrl` is required for
 * the api-key / basic / no-auth flows (a curated vendor's URL comes from the
 * catalog, a custom OAuth server's from Nango). `apiKeyHeader` is honored only
 * for the api-key flow (absent → `Authorization: Bearer`). The auth kind itself
 * is NEVER on the wire — the server derives it from the posted `providerKey`.
 */
export const confirmMcpParamsSchema = z.object({
  serverUrl: z.url().max(2048).optional(),
  apiKeyHeader: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9-]*$/)
    .max(128)
    .optional(),
  /** Remote transport of the chosen endpoint. Defaults to `http`. */
  transport: z.enum(["http", "sse"]).optional(),
  /** Logo URL from the discovery catalog. Favicon fallback otherwise. */
  iconUrl: z.string().max(2048).optional(),
  /** One-line app description from the discovery catalog. */
  description: z.string().max(2000).optional(),
  /**
   * Discovery-catalog metadata. `verified` only grants auto-run trust when a
   * `qualifiedName` is present (a real catalog app) — the server re-clamps it.
   */
  catalogMeta: z
    .object({
      qualifiedName: z.string().max(256).optional(),
      homepage: z.string().max(2048).optional(),
      categories: z.array(z.string().max(64)).max(20).optional(),
      verified: z.boolean().optional(),
    })
    .optional(),
});
export type ConfirmMcpParams = z.infer<typeof confirmMcpParamsSchema>;

export const confirmConnectionRequestSchema = z.object({
  providerKey: z.string().min(1),
  displayName: z.string().min(1).max(128),
  /**
   * The Nango connection id. Absent ONLY for a no-auth custom MCP server
   * (`mcp-custom-none`), which has no Nango row at all.
   */
  nangoConnectionId: z.string().min(1).max(128).optional(),
  scope: connectionScopeSchema,
  /**
   * Per-provider runtime options keyed by the provider's
   * `connectionOptions` descriptor. Validated dynamically server-side
   * against that descriptor. Required when the provider declares one,
   * ignored otherwise.
   */
  options: z.record(z.string(), z.unknown()).optional(),
  /** Custom MCP server params (URL + optional key header). */
  mcp: confirmMcpParamsSchema.optional(),
});
export type ConfirmConnectionRequest = z.infer<
  typeof confirmConnectionRequestSchema
>;

export const mcpAuthKindSchema = z.enum(externalAppMcpAuthKindEnum.enumValues);
export type McpAuthKindValue = z.infer<typeof mcpAuthKindSchema>;

export const externalAppConnectionStatusSchema = z.enum(
  externalAppConnectionStatusEnum.enumValues,
);
export type ExternalAppConnectionStatusValue = z.infer<
  typeof externalAppConnectionStatusSchema
>;

export const externalAppConcurrencyModeSchema = z.enum(
  externalAppConcurrencyModeEnum.enumValues,
);
export type ExternalAppConcurrencyModeValue = z.infer<
  typeof externalAppConcurrencyModeSchema
>;

/**
 * One tool of a connection, surfaced so Settings → Tool permissions can render
 * a per-tool policy row. For MCP connections these come from the connection's
 * introspected snapshot (the static provider catalog carries no MCP actions);
 * `defaultLevel` is the descriptor's `approvalDefault` — curated reads auto-run,
 * custom actions gate — so the UI shows the true baseline and keeps the override
 * map sparse.
 */
export const connectionActionEntrySchema = z.object({
  name: z.string(),
  kind: z.enum(["read", "write"]),
  summary: z.string(),
  defaultLevel: toolPolicyLevelSchema,
});
export type ConnectionActionEntry = z.infer<typeof connectionActionEntrySchema>;

export const externalAppConnectionResponseSchema = z.object({
  id: z.uuid(),
  providerKey: z.string(),
  displayName: z.string(),
  scope: connectionScopeSchema,
  status: externalAppConnectionStatusSchema,
  /**
   * MCP connections only: state of the tool snapshot. `ready` = tools compiled
   * and usable; `preparing` = introspection hasn't landed yet; `error` =
   * introspection failed (see `lastErrorMessage`). `null` for manifest providers
   * (no snapshot concept).
   */
  toolStatus: z.enum(["ready", "preparing", "error"]).nullable(),
  /** MCP connections only — how the direct transport authenticates. `null` for manifest providers. */
  mcpAuthKind: mcpAuthKindSchema.nullable(),
  /** MCP connections only — the server endpoint. `null` for manifest providers. */
  mcpServerUrl: z.string().nullable(),
  /**
   * MCP connections only — the app's logo (Iconify name or image URL). `null`
   * for manifest providers (their icon comes from the provider catalogue).
   */
  iconUrl: z.string().nullable(),
  /** MCP connections only — one-line app description. `null` for manifest providers. */
  description: z.string().nullable(),
  options: z.record(z.string(), z.unknown()).nullable(),
  /** Per-action permission overrides on this connection (absent = defaults). */
  actionPolicies: z.record(z.string(), toolPolicyLevelSchema).nullable(),
  /** `null` = follows the provider's manifest (`parallel` unless declared). */
  concurrencyMode: externalAppConcurrencyModeSchema.nullable(),
  /**
   * MCP connections only — the introspected tools of this connection's current
   * snapshot, so the tool-permissions UI can render a per-tool policy row.
   * `null` for manifest providers (their tools come from the provider catalogue)
   * and for MCP connections still preparing / errored (no snapshot yet).
   */
  actions: z.array(connectionActionEntrySchema).nullable(),
  lastErrorMessage: z.string().nullable(),
  createdByUserId: z.uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ExternalAppConnectionResponse = z.infer<
  typeof externalAppConnectionResponseSchema
>;

export const externalAppConnectionsListResponseSchema = z.object({
  connections: z.array(externalAppConnectionResponseSchema),
});
export type ExternalAppConnectionsListResponse = z.infer<
  typeof externalAppConnectionsListResponseSchema
>;

/**
 * One discoverable MCP app in the catalog — an Official MCP Registry server
 * (metadata only; discovery). `qualifiedName` is the id the connect flow
 * inspects; the app is connected direct to its own first-party endpoint.
 * `verified` = the namespace is DNS-verified (official).
 */
export const mcpCatalogEntrySchema = z.object({
  qualifiedName: z.string(),
  displayName: z.string(),
  description: z.string(),
  iconUrl: z.string().nullable(),
  homepage: z.string().nullable(),
  verified: z.boolean(),
});
export type McpCatalogEntryDto = z.infer<typeof mcpCatalogEntrySchema>;

export const mcpCatalogPaginationSchema = z.object({
  currentPage: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
  totalCount: z.number(),
});

export const mcpCatalogResponseSchema = z.object({
  entries: z.array(mcpCatalogEntrySchema),
  pagination: mcpCatalogPaginationSchema,
});
export type McpCatalogResponse = z.infer<typeof mcpCatalogResponseSchema>;

/** Query for `GET /external-apps/mcp-catalog` (registry-backed search). */
export const mcpCatalogQuerySchema = z.object({
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});
export type McpCatalogQuery = z.infer<typeof mcpCatalogQuerySchema>;

/**
 * Inspect a discovered server before connecting: resolve its direct endpoint
 * and auto-detect the auth mode. One of `qualifiedName` (catalog app) or
 * `serverUrl` (raw custom URL) is required.
 */
export const mcpInspectRequestSchema = z
  .object({
    qualifiedName: z.string().max(256).optional(),
    serverUrl: z.url().max(2048).optional(),
  })
  .refine((v) => v.qualifiedName !== undefined || v.serverUrl !== undefined, {
    message: "Provide a qualifiedName or a serverUrl.",
  });
export type McpInspectRequest = z.infer<typeof mcpInspectRequestSchema>;

export const mcpInspectResponseSchema = z.object({
  /** True when the server exposes a reachable endpoint. */
  connectable: z.boolean(),
  serverUrl: z.string().nullable(),
  /** Remote transport of the resolved endpoint (`sse` needs the SSE transport). */
  transport: z.enum(["http", "sse"]).nullable(),
  suggestedAuthMode: z.enum(["oauth", "none", "manual"]),
  /** API-key header the server template declares, to pre-fill the manual form. */
  suggestedApiKeyHeader: z.string().nullable(),
  displayName: z.string().nullable(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
  verified: z.boolean(),
  homepage: z.string().nullable(),
  qualifiedName: z.string().nullable(),
  tools: z.array(
    z.object({ name: z.string(), description: z.string().nullable() }),
  ),
});
export type McpInspectResponse = z.infer<typeof mcpInspectResponseSchema>;

export const updateConnectionRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    status: externalAppConnectionStatusSchema.optional(),
    /**
     * Partial options patch — merged with the existing JSONB; the result is
     * re-validated against the provider's `connectionOptions` descriptor.
     */
    options: z.record(z.string(), z.unknown()).optional(),
    /**
     * Sparse per-action policy patch — a level sets the override, `null` resets
     * to the manifest default. Team-scoped connections require admin.
     */
    actionPolicies: z
      .record(z.string(), toolPolicyLevelSchema.nullable())
      .optional(),
    /**
     * Override how many calls this ACCOUNT tolerates at once; `null` follows the
     * provider's manifest again. The lever for a third party whose limit is not
     * a property of the app but of the plan the customer bought — and the only
     * one an MCP connection has, since it carries no manifest.
     */
    concurrencyMode: externalAppConcurrencyModeSchema.nullable().optional(),
  })
  .refine(
    (val) =>
      val.displayName !== undefined ||
      val.status !== undefined ||
      val.options !== undefined ||
      val.actionPolicies !== undefined ||
      val.concurrencyMode !== undefined,
    {
      message:
        "At least one of displayName, status, options, actionPolicies or concurrencyMode must be provided",
    },
  );
export type UpdateConnectionRequest = z.infer<
  typeof updateConnectionRequestSchema
>;

export const deleteConnectionResponseSchema = z.object({
  id: z.uuid(),
  deleted: z.literal(true),
});
export type DeleteConnectionResponse = z.infer<
  typeof deleteConnectionResponseSchema
>;

// ============================================================================
// Test credentials (POST /external-apps/connections/test-credentials)
// ============================================================================

/**
 * Generic test-credentials payload — shape of `credentials` and
 * `connectionConfig` is provider-specific (validated server-side by the
 * provider's own `testCredentials` implementation).
 */
export const testCredentialsRequestSchema = z.object({
  providerKey: z.string().min(1).openapi({
    example: "imap-smtp",
    description: "Provider key whose `testCredentials` to invoke.",
  }),
  credentials: z.record(z.string(), z.unknown()).openapi({
    description: "Field values targeting Nango `credentials`.",
  }),
  connectionConfig: z.record(z.string(), z.unknown()).openapi({
    description: "Field values targeting Nango `connection_config`.",
  }),
});
export type TestCredentialsRequest = z.infer<
  typeof testCredentialsRequestSchema
>;

export const testCredentialsResponseSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    /** Optional sub-system that failed (e.g. `imap`, `smtp`). */
    scope: z.string().optional(),
    message: z.string(),
  }),
]);
export type TestCredentialsResponse = z.infer<
  typeof testCredentialsResponseSchema
>;

/**
 * Options resolver for a `dynamic-select` credential field — the front
 * sends whatever it has typed so far (split by `target`); the server
 * looks up the provider's registered handler and returns the option list.
 * The connection isn't created yet; nothing here gets persisted.
 */
export const dynamicOptionsRequestSchema = z.object({
  providerKey: z.string().min(1).openapi({
    example: "shiptify",
    description: "Provider key whose dynamic-options handler to invoke.",
  }),
  fieldKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .openapi({
      example: "account_id",
      description:
        "Key of the `dynamic-select` field whose options must be resolved.",
    }),
  credentials: z.record(z.string(), z.unknown()).openapi({
    description: "In-progress field values targeting Nango `credentials`.",
  }),
  connectionConfig: z.record(z.string(), z.unknown()).openapi({
    description:
      "In-progress field values targeting Nango `connection_config`.",
  }),
});
export type DynamicOptionsRequest = z.infer<typeof dynamicOptionsRequestSchema>;

export const dynamicOptionsResponseSchema = z.object({
  options: z
    .array(
      z.object({
        value: z.string(),
        label: z.string(),
        /**
         * Optional per-option metadata. The frontend modal uses it to
         * auto-fill sibling form fields when the user picks an option —
         * e.g. Shiptify's `listAccounts` ships `meta: { account_type:
         * "shipper" | "carrier" }`, which the modal projects into the
         * `connectionOptions.account_type` form so the agent learns the
         * connection's role without the user having to pick it twice.
         */
        meta: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .openapi({
      description:
        "Resolved option list — `value` lands in the form's field value; `label` is what the user sees in the dropdown; `meta` (optional) carries per-option payload the frontend can project into sibling fields.",
    }),
});
export type DynamicOptionsResponse = z.infer<
  typeof dynamicOptionsResponseSchema
>;
