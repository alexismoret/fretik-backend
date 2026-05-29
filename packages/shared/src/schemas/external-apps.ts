import { z } from "@hono/zod-openapi";
import { externalAppConnectionStatusEnum } from "../db/schema/external-apps";
import {
  connectionOptionsDescriptorSchema,
  credentialsFormDescriptorSchema,
  providerTransportSchema,
} from "../external-apps/manifest-schema";

/**
 * HTTP schemas for `/external-apps/*` and `/sandbox/exec` routes.
 *
 * The wire shape is intentionally **distinct** from the DB row types
 * (`ExternalAppConnection`, `ToolApprovalRequest`): we strip Nango-internal
 * columns (`nangoProviderConfigKey`) and surface a friendlier `scope` enum
 * derived from `userId IS NULL`.
 *
 * The provider catalogue (`GET /external-apps/providers`) is built from
 * the in-memory registry — no DB row, no manifest YAML on the wire.
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

export const confirmConnectionRequestSchema = z.object({
  providerKey: z.string().min(1),
  displayName: z.string().min(1).max(128),
  nangoConnectionId: z.string().min(1).max(128),
  scope: connectionScopeSchema,
  /**
   * Per-provider runtime options keyed by the provider's
   * `connectionOptions` descriptor. Validated dynamically server-side
   * against that descriptor. Required when the provider declares one,
   * ignored otherwise.
   */
  options: z.record(z.string(), z.unknown()).optional(),
});
export type ConfirmConnectionRequest = z.infer<
  typeof confirmConnectionRequestSchema
>;

export const externalAppConnectionStatusSchema = z.enum(
  externalAppConnectionStatusEnum.enumValues,
);
export type ExternalAppConnectionStatusValue = z.infer<
  typeof externalAppConnectionStatusSchema
>;

export const externalAppConnectionResponseSchema = z.object({
  id: z.uuid(),
  providerKey: z.string(),
  displayName: z.string(),
  scope: connectionScopeSchema,
  status: externalAppConnectionStatusSchema,
  options: z.record(z.string(), z.unknown()).nullable(),
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

export const updateConnectionRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    status: externalAppConnectionStatusSchema.optional(),
    /**
     * Partial options patch — merged with the existing JSONB; the result is
     * re-validated against the provider's `connectionOptions` descriptor.
     */
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (val) =>
      val.displayName !== undefined ||
      val.status !== undefined ||
      val.options !== undefined,
    {
      message:
        "At least one of displayName, status or options must be provided",
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

// ============================================================================
// Tool approval requests (GET/POST /external-apps/approvals/:id/*)
// ============================================================================

export const toolApprovalStatusSchema = z.enum([
  "pending",
  "granted",
  "executing",
  "consumed",
  "rejected",
]);
export type ToolApprovalStatusValue = z.infer<typeof toolApprovalStatusSchema>;

/** A single op as stored in `tool_approval_requests.operations`. */
export const toolApprovalOperationSchema = z.object({
  action: z.string().min(1).openapi({
    example: "outlook.send_email",
    description: "Fully-qualified action name (provider.action).",
  }),
  args: z.record(z.string(), z.unknown()).openapi({
    description:
      "Executable args. Validated server-side against the manifest at modify-time.",
  }),
});
export type ToolApprovalOperationDto = z.infer<
  typeof toolApprovalOperationSchema
>;

/** A field on the approval card, after backend i18n rendering. */
export const renderedApprovalFieldSchema = z.object({
  label: z.string(),
  value: z.string(),
  kind: z.enum(["text", "html"]).optional(),
});
export type RenderedApprovalFieldDto = z.infer<
  typeof renderedApprovalFieldSchema
>;

export const renderedApprovalOperationSchema = z.object({
  providerKey: z.string(),
  action: z.string(),
  title: z.string(),
  fields: z.array(renderedApprovalFieldSchema),
});
export type RenderedApprovalOperationDto = z.infer<
  typeof renderedApprovalOperationSchema
>;

export const renderedApprovalSummarySchema = z.object({
  title: z.string(),
  operations: z.array(renderedApprovalOperationSchema),
});
export type RenderedApprovalSummaryDto = z.infer<
  typeof renderedApprovalSummarySchema
>;

/** Outcome of a single op after execution — mirrors `ToolApprovalOpResult`. */
export const toolApprovalOpResultSchema = z.union([
  z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type ToolApprovalOpResultDto = z.infer<
  typeof toolApprovalOpResultSchema
>;

export const approvalResponseSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  turnId: z.string(),
  status: toolApprovalStatusSchema,
  itemCount: z.int(),
  /** Translated, ready-to-render. */
  summary: renderedApprovalSummarySchema,
  /** Raw ops (mutable via modify-and-grant). */
  operations: z.array(toolApprovalOperationSchema),
  result: z.array(toolApprovalOpResultSchema).nullable(),
  decisionFeedback: z.string().nullable(),
  decisionAt: z.coerce.date().nullable(),
  executedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;

export const modifyAndGrantRequestSchema = z.object({
  operations: z.array(toolApprovalOperationSchema).min(1),
});
export type ModifyAndGrantRequest = z.infer<typeof modifyAndGrantRequestSchema>;

export const rejectApprovalRequestSchema = z.object({
  feedback: z.string().max(4096).optional(),
});
export type RejectApprovalRequest = z.infer<typeof rejectApprovalRequestSchema>;

// ============================================================================
// Sandbox dispatch (POST /sandbox/exec) — called by `_runtime.py`
// ============================================================================

export const sandboxExecRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("read"),
    action: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    turnId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("plan"),
    operations: z.array(toolApprovalOperationSchema).min(1),
    turnId: z.string().min(1),
  }),
]);
export type SandboxExecRequestDto = z.infer<typeof sandboxExecRequestSchema>;

export const sandboxExecResponseSchema = z.union([
  z.object({ status: z.literal("ok"), data: z.unknown() }),
  z.object({
    status: z.literal("approval_pending"),
    approvalId: z.uuid(),
  }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    data: z.unknown().optional(),
  }),
]);
export type SandboxExecResponseDto = z.infer<typeof sandboxExecResponseSchema>;
