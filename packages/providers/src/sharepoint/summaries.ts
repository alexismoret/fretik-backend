import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  asString,
  isRecord,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Approval-card summaries for every SharePoint write action.
 *
 * Rule (ADDING_A_PROVIDER.md §8): the card is read by a non-technical user,
 * so it carries only what they can actually check — file and folder names,
 * recipient emails, the role being granted, the row's own column values —
 * and never a Graph identifier. `drive_id`, `item_id`, `site_id`,
 * `list_id`, `permission_id` are all opaque strings that tell the reader
 * nothing about what is at stake.
 *
 * That leaves three cards carrying nothing but their title (`delete_item`,
 * `revoke_item_access`, `delete_list_item`), which is the correct outcome:
 * every argument they take is an id. The agent named the target in the
 * sentence it wrote just above the card; inventing a lookup here would cost
 * a Graph round-trip per approval and mappers are synchronous anyway.
 */

const field = (labelKey: string, value: string): ToolApprovalSummaryField => ({
  labelKey,
  value,
});

const optionalField = (
  labelKey: string,
  value: string | undefined,
): ToolApprovalSummaryField | null =>
  value !== undefined && value !== "" ? field(labelKey, value) : null;

const compact = (
  ...fields: (ToolApprovalSummaryField | null)[]
): ToolApprovalSummaryField[] =>
  fields.filter((f): f is ToolApprovalSummaryField => f !== null);

/**
 * Render a list row's column values as `Column: value` lines. This is the
 * whole reviewable substance of a list write — without it the user is
 * approving "update a row" with no idea which values change.
 */
const fieldsPreview = (value: unknown): string | undefined => {
  if (!isRecord(value)) return undefined;
  const lines = Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([key, v]) => `${key}: ${String(v)}`);
  return lines.length > 0 ? lines.join("\n") : undefined;
};

// ── Files & folders ────────────────────────────────────────────────────

const createFolder: SummaryMapper = (args): OperationSummaryPart => ({
  titleKey: "default",
  titleParams: { name: str(args.name) },
  fields: compact(field("display_name", str(args.name))),
});

/**
 * `replace` supersedes a file that already carries this name. It is the one
 * choice on this card with a consequence the reader cannot infer from the
 * file name, so it changes the TITLE rather than adding a row — a field
 * value is stored verbatim and never translated, and "replace" alone would
 * not tell a French reader what is about to happen to their document.
 */
const createUploadSession: SummaryMapper = (args) => ({
  titleKey:
    str(args.conflict_behavior, "rename") === "replace" ? "replace" : "default",
  titleParams: { name: str(args.file_name) },
  fields: compact(field("file_name", str(args.file_name))),
});

/**
 * One action, three user-visible acts. The move target is an id nobody can
 * verify, so the title carries the distinction instead.
 */
const updateItem: SummaryMapper = (args) => {
  const newName = asString(args.new_name);
  const moved = asString(args.new_parent_folder_id);
  const renaming = newName !== undefined && newName !== "";
  const moving = moved !== undefined && moved !== "";
  return {
    titleKey: renaming && moving ? "rename_move" : moving ? "move" : "rename",
    titleParams: { name: newName ?? "" },
    fields: compact(optionalField("new_name", newName)),
  };
};

const deleteItem: SummaryMapper = () => ({ titleKey: "default", fields: [] });

const copyItem: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(optionalField("new_name", asString(args.new_name))),
});

const restoreVersion: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { version: str(args.version_id) },
  fields: compact(field("version", str(args.version_id))),
});

/**
 * An `anonymous` link is readable by anyone who ever receives the URL, with
 * no sign-in and no way to tell who opened it. That is a different decision
 * from an internal link, so it gets its own title rather than a `scope:
 * anonymous` row the eye slides past.
 */
const createShareLink: SummaryMapper = (args) => ({
  titleKey:
    str(args.scope, "organization") === "anonymous" ? "anonymous" : "default",
  fields: compact(
    field("link_type", str(args.link_type, "view")),
    field("link_scope", str(args.scope, "organization")),
    optionalField("expires_at", asString(args.expiration_date)),
  ),
});

const grantItemAccess: SummaryMapper = (args) => {
  const emails = strArray(args.emails);
  return {
    titleKey: "default",
    titleParams: { recipients: emails.join(", ") },
    fields: compact(
      field("to", emails.join(", ")),
      field("role", str(args.role, "read")),
      optionalField("message", asString(args.message)),
      optionalField("expires_at", asString(args.expiration_date)),
    ),
  };
};

const revokeItemAccess: SummaryMapper = () => ({
  titleKey: "default",
  fields: [],
});

// ── List rows ──────────────────────────────────────────────────────────

const createListItem: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(optionalField("values", fieldsPreview(args.fields))),
});

const updateListItem: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(optionalField("new_values", fieldsPreview(args.fields))),
});

const deleteListItem: SummaryMapper = () => ({
  titleKey: "default",
  fields: [],
});

export const sharepointSummaries: ProviderSummaries = {
  create_folder: createFolder,
  create_upload_session: createUploadSession,
  update_item: updateItem,
  delete_item: deleteItem,
  copy_item: copyItem,
  restore_version: restoreVersion,
  create_share_link: createShareLink,
  grant_item_access: grantItemAccess,
  revoke_item_access: revokeItemAccess,
  create_list_item: createListItem,
  update_list_item: updateListItem,
  delete_list_item: deleteListItem,
};
