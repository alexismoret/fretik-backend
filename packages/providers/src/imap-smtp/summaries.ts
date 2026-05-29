import type { ToolApprovalSummaryField } from "@fretik/shared/db/schema";
import {
  arr,
  asString,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Approval-card summaries for the IMAP/SMTP provider's 8 write actions.
 * Mirrors the structure of Outlook's `summaries.ts` — `labelKey`s reuse
 * the same `external_apps.approvals.fields.*` keys when semantically
 * identical (recipients, subject, body, attachments, …); titles live
 * under `chatbot.approvals.imap-smtp.<action>.title.<variant>`.
 */

const field = (
  labelKey: string,
  value: string,
  kind?: "text" | "html",
): ToolApprovalSummaryField =>
  kind ? { labelKey, value, kind } : { labelKey, value };

const optionalField = (
  labelKey: string,
  value: string | undefined,
  kind?: "text" | "html",
): ToolApprovalSummaryField | null =>
  value !== undefined && value !== "" ? field(labelKey, value, kind) : null;

const emailsField = (
  labelKey: string,
  value: unknown,
): ToolApprovalSummaryField | null => {
  const list = strArray(value);
  return list.length > 0 ? field(labelKey, list.join(", ")) : null;
};

const attachmentsField = (value: unknown): ToolApprovalSummaryField | null => {
  const items = arr(value);
  if (items.length === 0) return null;
  const summary = items
    .map((item) => {
      const name = str(prop(item, "name"));
      const type = asString(prop(item, "content_type"));
      return type !== undefined ? `${name} (${type})` : name;
    })
    .join(", ");
  return field("attachments", `${items.length.toString()}: ${summary}`);
};

const compact = (
  ...fields: (ToolApprovalSummaryField | null)[]
): ToolApprovalSummaryField[] =>
  fields.filter((f): f is ToolApprovalSummaryField => f !== null);

const recipientsParam = (value: unknown): string => {
  const list = strArray(value);
  return list.length > 0 ? list.join(", ") : "";
};

// ── Mail writes ────────────────────────────────────────────────────────

const sendEmail: SummaryMapper = (args): OperationSummaryPart => ({
  titleKey: "default",
  titleParams: { recipients: recipientsParam(args.to) },
  fields: compact(
    emailsField("to", args.to),
    emailsField("cc", args.cc),
    emailsField("bcc", args.bcc),
    field("subject", str(args.subject)),
    field("body", str(args.body_html), "html"),
    attachmentsField(args.attachments),
  ),
});

const replyEmail: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    field("message_id", str(args.message_id)),
    field("body", str(args.body_html), "html"),
    attachmentsField(args.attachments),
  ),
});

const forwardEmail: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { recipients: recipientsParam(args.to) },
  fields: compact(
    field("message_id", str(args.message_id)),
    emailsField("to", args.to),
    optionalField("comment", asString(args.comment)),
    attachmentsField(args.attachments),
  ),
});

const deleteMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [field("message_id", str(args.message_id))],
});

const moveMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [
    field("message_id", str(args.message_id)),
    field("destination_folder", str(args.destination_folder_id)),
  ],
});

const markRead: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [field("message_id", str(args.message_id))],
});

const markUnread: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [field("message_id", str(args.message_id))],
});

const createFolder: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.display_name) },
  fields: compact(
    field("display_name", str(args.display_name)),
    optionalField("parent_folder", asString(args.parent_folder_id)),
  ),
});

// ── Batch summaries (count-aware) ─────────────────────────────────────
//
// One approval card row no matter how many message_ids — the title
// shows the count, the body shows a short preview (first 5 ids) so a
// human reviewer can spot-check before granting.

/** Render up to the first 5 ids with a "+N more" tail. */
const idsPreview = (ids: string[]): string => {
  if (ids.length === 0) return "";
  const head = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${head}, …(+${(ids.length - 5).toString()})` : head;
};

const deleteMessages: SummaryMapper = (args) => {
  const ids = strArray(args.message_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: compact(
      field("count", ids.length.toString()),
      ids.length > 0 ? field("message_ids_preview", idsPreview(ids)) : null,
    ),
  };
};

const moveMessages: SummaryMapper = (args) => {
  const ids = strArray(args.message_ids);
  return {
    titleKey: "default",
    titleParams: {
      count: ids.length.toString(),
      destination: str(args.destination_folder_id),
    },
    fields: compact(
      field("count", ids.length.toString()),
      field("destination_folder", str(args.destination_folder_id)),
      ids.length > 0 ? field("message_ids_preview", idsPreview(ids)) : null,
    ),
  };
};

const markMessagesRead: SummaryMapper = (args) => {
  const ids = strArray(args.message_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: compact(
      field("count", ids.length.toString()),
      ids.length > 0 ? field("message_ids_preview", idsPreview(ids)) : null,
    ),
  };
};

const markMessagesUnread: SummaryMapper = (args) => {
  const ids = strArray(args.message_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: compact(
      field("count", ids.length.toString()),
      ids.length > 0 ? field("message_ids_preview", idsPreview(ids)) : null,
    ),
  };
};

export const imapSmtpSummaries: ProviderSummaries = {
  send_email: sendEmail,
  reply_email: replyEmail,
  forward_email: forwardEmail,
  mark_read: markRead,
  mark_unread: markUnread,
  delete_message: deleteMessage,
  move_message: moveMessage,
  delete_messages: deleteMessages,
  move_messages: moveMessages,
  mark_messages_read: markMessagesRead,
  mark_messages_unread: markMessagesUnread,
  create_folder: createFolder,
};
