import type {
  ToolApprovalOperationSummary,
  ToolApprovalSummary,
  ToolApprovalSummaryField,
} from "../../db/schema/approvals";
import { i18n } from "./index";

/**
 * Renderer that turns the structural `ToolApprovalSummary` stored in DB
 * into a fully-translated payload ready for display (approval card on the
 * frontend today, agent-stop email tomorrow).
 *
 * Pass the team's language from `team_settings.lang`; falls back to `en`
 * when missing or unsupported.
 */

export interface RenderedApprovalField {
  label: string;
  value: string;
  kind?: "text" | "html";
}

export interface RenderedApprovalOperation {
  providerKey: string;
  action: string;
  title: string;
  fields: RenderedApprovalField[];
}

export interface RenderedApprovalSummary {
  title: string;
  operations: RenderedApprovalOperation[];
}

const renderField = (
  field: ToolApprovalSummaryField,
  lang: string,
): RenderedApprovalField => {
  const label = i18n.t(`external_apps.approvals.fields.${field.labelKey}`, {
    lng: lang,
    defaultValue: field.labelKey,
  });
  return field.kind
    ? { label, value: field.value, kind: field.kind }
    : { label, value: field.value };
};

const renderOperation = (
  op: ToolApprovalOperationSummary,
  lang: string,
): RenderedApprovalOperation => {
  const title = i18n.t(
    `external_apps.approvals.${op.providerKey}.${op.action}.title.${op.titleKey}`,
    {
      lng: lang,
      defaultValue: i18n.t(
        `external_apps.approvals.${op.providerKey}.${op.action}.title.default`,
        { lng: lang, defaultValue: op.action, ...op.titleParams },
      ),
      ...op.titleParams,
    },
  );
  return {
    providerKey: op.providerKey,
    action: op.action,
    title,
    fields: op.fields.map((f) => renderField(f, lang)),
  };
};

export const renderApprovalSummary = (
  summary: ToolApprovalSummary,
  lang = "en",
): RenderedApprovalSummary => ({
  title: i18n.t(`external_apps.approvals.plan.title.${summary.titleKey}`, {
    lng: lang,
    defaultValue: i18n.t(`external_apps.approvals.plan.title.default`, {
      lng: lang,
      ...summary.titleParams,
    }),
    ...summary.titleParams,
  }),
  operations: summary.operations.map((op) => renderOperation(op, lang)),
});
