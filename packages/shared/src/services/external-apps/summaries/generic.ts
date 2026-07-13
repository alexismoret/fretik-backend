import type { ToolApprovalOperationSummary } from "../../../db/schema";
import type { ExternalAppDescriptorAction } from "../../../schemas/external-app-descriptor";

/**
 * Build an approval-card operation summary for a source with NO hand-written
 * summary mapper — an MCP vendor tool. Manifest actions carry a per-action
 * `summary(args)` mapper that composes i18n-keyed titles + curated fields; a
 * dynamically-introspected tool has neither, so we render generically:
 *
 *  - the title is the vendor tool's own one-line description (`action.summary`),
 *    emitted as a literal `titleText` the renderer uses verbatim;
 *  - EVERY call arg becomes a field, labelled by its raw param name (no i18n
 *    key → the renderer falls back to the label), so the user sees the FULL set
 *    of data the write will send before granting it — hiding a field would
 *    defeat the point of the approval card.
 *
 * `connection_id` (the resolved framework arg) is dropped — it's plumbing, not
 * user-facing content. Long values are truncated for DISPLAY only; the real arg
 * lives untouched in `op.args`.
 */

const MAX_VALUE_CHARS = 2000;

const truncate = (s: string): string =>
  s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS - 1)}…` : s;

const renderValue = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncate(JSON.stringify(value, null, 2));
  } catch {
    // Non-serializable (e.g. a circular structure) — never happens for MCP
    // JSON args, but keep the card resilient rather than throwing.
    return "[unserializable]";
  }
};

export const buildGenericOperationSummary = (params: {
  providerKey: string;
  action: ExternalAppDescriptorAction;
  /** Clean call args (framework args already stripped). */
  args: Record<string, unknown>;
}): ToolApprovalOperationSummary => {
  const fields = Object.entries(params.args)
    .filter(([key]) => key !== "connection_id")
    .map(([key, value]) => ({ labelKey: key, value: renderValue(value) }));

  return {
    providerKey: params.providerKey,
    action: params.action.name,
    titleKey: "default",
    titleText: params.action.summary,
    fields,
  };
};
