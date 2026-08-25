import { z } from "zod";
import {
  paramSpecSchema,
  returnSpecSchema,
} from "../external-apps/manifest-schema";

/**
 * `ExternalAppDescriptor` — the source-agnostic intermediate representation
 * (IR) every external app compiles to, whatever its origin:
 *
 *  - a hand-written `ProviderManifest` (compile-time, the 6 current apps),
 *  - an MCP server introspected at connection time (`tools/list`),
 *  - a future OpenAPI import.
 *
 * One IR feeds one deterministic codegen (`@fretik/providers/codegen`) →
 * the Python SDK stub + SKILL the agent reads. It is deliberately a
 * STRUCTURAL SUPERSET of the codegen's `CodegenProvider` view (same `key`,
 * `displayName`, `description`, `categories`, `types`, `actions`) so a
 * descriptor flows straight into `emitProviderModule(...)` with no adapter,
 * while carrying the extra classification/source metadata (`source`,
 * `transport`, `fingerprint`, per-action `kind`/`approvalDefault`) that the
 * dispatcher and approval gate need.
 *
 * Kept in `@fretik/shared` (not `@fretik/providers`) because the dispatcher,
 * the MCP introspection job, and the catalog all consume it, and none of
 * them may import a provider directly.
 */

/** How the dispatcher executes this app's actions. `mcp` is new in the refonte. */
export const externalAppTransportSchema = z.enum([
  "nango-proxy",
  "custom-handler",
  "http-direct",
  "mcp",
]);
export type ExternalAppTransport = z.infer<typeof externalAppTransportSchema>;

/** Where the descriptor was compiled from. */
export const externalAppSourceSchema = z.enum(["manifest", "openapi", "mcp"]);
export type ExternalAppSource = z.infer<typeof externalAppSourceSchema>;

/**
 * How each action's read/write classification was decided — drives trust:
 *  - `manifest`   : authored by hand (fully trusted).
 *  - `annotation` : from an MCP tool's `readOnlyHint`/`destructiveHint`.
 *  - `llm`        : inferred at introspection when annotations were absent.
 *  - `default`    : no signal at all → write-gated by policy.
 *  - `admin`      : overridden per-connection by a team admin.
 */
export const actionKindSourceSchema = z.enum([
  "manifest",
  "annotation",
  "llm",
  "default",
  "admin",
]);
export type ActionKindSource = z.infer<typeof actionKindSourceSchema>;

/** Default gate applied before an action runs (a team may override per-connection). */
export const approvalDefaultSchema = z.enum(["auto", "approval", "blocked"]);
export type ApprovalDefault = z.infer<typeof approvalDefaultSchema>;

/**
 * MCP tool behavioural hints (spec: untrusted — a server may lie or omit).
 * Retained on the descriptor so the classification decision stays auditable.
 */
export const mcpToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
});
export type McpToolAnnotations = z.infer<typeof mcpToolAnnotationsSchema>;

export const externalAppDescriptorActionSchema = z.object({
  /** Snake-case action name — becomes the Python function name. */
  name: z.string(),
  /** `read` → eager; `write` → plan-gated. */
  kind: z.enum(["read", "write"]),
  kindSource: actionKindSourceSchema,
  /** One-line description — SDK docstring + SKILL reference line. */
  summary: z.string(),
  approvalDefault: approvalDefaultSchema,
  params: z.record(z.string(), paramSpecSchema),
  returns: returnSpecSchema,
  /**
   * MCP-sourced actions only — the REAL server tool name (may contain
   * hyphens, e.g. `notion-search`) that dispatch must call. The action
   * `name` above is its sanitized snake_case form (the Python function),
   * so this preserves the round-trip. Absent for manifest actions (their
   * `name` IS the dispatch name).
   */
  mcpToolName: z.string().optional(),
  /** Present only for MCP-sourced actions. */
  annotations: mcpToolAnnotationsSchema.optional(),
  /** Optional mustache-lite template for a richer approval card (curated). */
  summaryTemplate: z.string().optional(),
});
export type ExternalAppDescriptorAction = z.infer<
  typeof externalAppDescriptorActionSchema
>;

/**
 * Declared trigger seam — the future workflow-triggers session fills this in
 * (webhook / poll event sources emitting `connector.<key>.<kind>`). Declared
 * now so the IR shape is stable; today every descriptor ships `triggers: []`.
 */
export const externalAppTriggerSchema = z.object({
  /** Event kind → domain event `connector.<providerKey>.<kind>`. */
  kind: z.string(),
  title: z.string(),
  description: z.string(),
  mode: z.enum(["webhook", "poll"]),
});
export type ExternalAppTrigger = z.infer<typeof externalAppTriggerSchema>;

export const externalAppDescriptorSchema = z.object({
  /** Provider/app key (kebab-case). Matches `CodegenProvider.key`. */
  key: z.string().regex(/^[a-z][a-z0-9-]*$/),
  displayName: z.string().min(1),
  /** Agent-facing one-liner (SKILL front-matter description). */
  description: z.string().min(1).optional(),
  source: externalAppSourceSchema,
  transport: externalAppTransportSchema,
  /**
   * Content hash of the action surface. For manifests: the manifest hash
   * (== the SKILL version). For MCP: `fingerprintTools(tools)`. Snapshots
   * and drift detection key off this.
   */
  fingerprint: z.string().min(1),
  categories: z.array(z.string()).min(1),
  /** Named reusable collections referenced by `returns` / params. */
  types: z.record(z.string(), z.record(z.string(), paramSpecSchema)),
  actions: z.array(externalAppDescriptorActionSchema).min(1),
  triggers: z.array(externalAppTriggerSchema),
});
export type ExternalAppDescriptor = z.infer<typeof externalAppDescriptorSchema>;
