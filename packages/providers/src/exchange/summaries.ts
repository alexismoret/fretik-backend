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
 * Approval-card summaries for the Exchange provider's 22 write actions.
 * Structural form only (i18n keys + params, not display strings). Titles
 * resolve under `external_apps.approvals.exchange.<action>.title.<variant>`;
 * field labels reuse the shared `external_apps.approvals.fields.*` set.
 * Mirrors `imap-smtp` / `outlook` summaries.
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

const recipientsParam = (value: unknown): string => strArray(value).join(", ");

/** Render up to the first 5 ids with a "+N more" tail. */
const idsPreview = (ids: string[]): string => {
  if (ids.length === 0) return "";
  const head = ids.slice(0, 5).join(", ");
  return ids.length > 5 ? `${head}, …(+${(ids.length - 5).toString()})` : head;
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
  ),
});

const replyAllEmail: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    field("message_id", str(args.message_id)),
    field("body", str(args.body_html), "html"),
  ),
});

const forwardEmail: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { recipients: recipientsParam(args.to) },
  fields: compact(
    field("message_id", str(args.message_id)),
    emailsField("to", args.to),
    optionalField("comment", asString(args.comment)),
  ),
});

const createDraft: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    emailsField("to", args.to),
    emailsField("cc", args.cc),
    field("subject", str(args.subject)),
    field("body", str(args.body_html), "html"),
    attachmentsField(args.attachments),
  ),
});

const updateDraft: SummaryMapper = (args) => {
  const subject = asString(args.subject);
  if (subject !== undefined && subject !== "") {
    return {
      titleKey: "withSubject",
      titleParams: { subject },
      fields: compact(
        field("draft_id", str(args.message_id)),
        field("new_subject", subject),
        optionalField("new_body", asString(args.body_html), "html"),
      ),
    };
  }
  return {
    titleKey: "default",
    fields: compact(
      field("draft_id", str(args.message_id)),
      optionalField("new_body", asString(args.body_html), "html"),
    ),
  };
};

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

const copyMessage: SummaryMapper = (args) => ({
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

const flagMessage: SummaryMapper = (args) => {
  const status = str(args.status, "flagged");
  const titleKey =
    status === "flagged" || status === "complete" || status === "notFlagged"
      ? status
      : "default";
  return {
    titleKey,
    fields: compact(
      field("message_id", str(args.message_id)),
      field("flag_status", status),
      optionalField("due_date", asString(args.due_date)),
    ),
  };
};

const createFolder: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.display_name) },
  fields: compact(
    field("display_name", str(args.display_name)),
    optionalField("parent_folder", asString(args.parent_folder_id)),
  ),
});

// ── Batch summaries (count-aware) ─────────────────────────────────────

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

// ── Calendar writes ────────────────────────────────────────────────────

const createCalendarEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { subject: str(args.subject) },
  fields: compact(
    field("subject", str(args.subject)),
    field("start", str(args.start)),
    field("end", str(args.end)),
    optionalField("location", asString(args.location)),
    emailsField("attendees", args.attendees),
    typeof args.is_online_meeting === "boolean"
      ? field("online_meeting", args.is_online_meeting ? "yes" : "no")
      : null,
    optionalField("body", asString(args.body_html), "html"),
  ),
});

const updateCalendarEvent: SummaryMapper = (args) => {
  const subject = asString(args.subject);
  if (subject !== undefined && subject !== "") {
    return {
      titleKey: "withSubject",
      titleParams: { subject },
      fields: compact(
        field("event_id", str(args.event_id)),
        field("new_subject", subject),
        optionalField("new_start", asString(args.start)),
        optionalField("new_end", asString(args.end)),
        optionalField("new_location", asString(args.location)),
        optionalField("new_body", asString(args.body_html), "html"),
      ),
    };
  }
  return {
    titleKey: "default",
    fields: compact(
      field("event_id", str(args.event_id)),
      optionalField("new_start", asString(args.start)),
      optionalField("new_end", asString(args.end)),
      optionalField("new_location", asString(args.location)),
      optionalField("new_body", asString(args.body_html), "html"),
    ),
  };
};

const deleteCalendarEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [field("event_id", str(args.event_id))],
});

const respondToEvent: SummaryMapper = (args) => {
  const response = str(args.response);
  const variant = ["accept", "decline", "tentativelyAccept"].includes(response)
    ? response
    : "default";
  return {
    titleKey: variant,
    fields: compact(
      field("event_id", str(args.event_id)),
      field("response", response),
      optionalField("comment", asString(args.comment)),
    ),
  };
};

// ── Contacts writes ────────────────────────────────────────────────────

const createContact: SummaryMapper = (args) => {
  const surname = asString(args.surname);
  const displayName =
    surname !== undefined && surname !== ""
      ? `${str(args.given_name)} ${surname}`
      : str(args.given_name);
  return {
    titleKey: "default",
    titleParams: { name: displayName },
    fields: compact(
      field("first_name", str(args.given_name)),
      optionalField("last_name", asString(args.surname)),
      optionalField("email", asString(args.email)),
      optionalField("company", asString(args.company_name)),
      optionalField("job_title", asString(args.job_title)),
      optionalField("phone", asString(args.mobile_phone)),
    ),
  };
};

export const exchangeSummaries: ProviderSummaries = {
  send_email: sendEmail,
  reply_email: replyEmail,
  reply_all_email: replyAllEmail,
  forward_email: forwardEmail,
  create_draft: createDraft,
  update_draft: updateDraft,
  delete_message: deleteMessage,
  move_message: moveMessage,
  copy_message: copyMessage,
  delete_messages: deleteMessages,
  move_messages: moveMessages,
  mark_messages_read: markMessagesRead,
  mark_messages_unread: markMessagesUnread,
  mark_read: markRead,
  mark_unread: markUnread,
  flag_message: flagMessage,
  create_folder: createFolder,
  create_calendar_event: createCalendarEvent,
  update_calendar_event: updateCalendarEvent,
  delete_calendar_event: deleteCalendarEvent,
  respond_to_event: respondToEvent,
  create_contact: createContact,
};
