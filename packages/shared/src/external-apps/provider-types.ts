import type { ToolApprovalSummaryField } from "../db/schema/external-apps";

/**
 * Contracts a provider module contributes alongside its declarative
 * manifest: HTTP request/response transformers and approval-card summaries.
 */

/** Dynamic parts of a Nango Proxy request produced by a request mapper. */
export interface ProxyRequestParts {
  /** Overrides the (already path-substituted) manifest path when set. */
  endpoint?: string;
  /** Query-string parameters. */
  query?: Record<string, string>;
  /** JSON request body. */
  body?: unknown;
}

/**
 * Transforms an action's clean args into the dynamic parts of the HTTP
 * request (the method + base path come from the manifest endpoint).
 */
export type RequestMapper = (
  args: Record<string, unknown>,
) => ProxyRequestParts;

/** Normalizes a raw provider response into the manifest's return shape. */
export type ResponseMapper = (raw: unknown) => unknown;

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

/** HTTP transformers a provider registers, keyed by mapper name. */
export interface ProviderMappers {
  request: Record<string, RequestMapper>;
  response: Record<string, ResponseMapper>;
}

/** Approval-card summary builders, keyed by action name. */
export type ProviderSummaries = Record<string, SummaryMapper>;
