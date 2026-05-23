import type { ToolApprovalSummaryField } from "../../../db/schema/external-apps";
import { arr, asString, prop, str, strArray } from "../../json-access";
import type {
  OperationSummaryPart,
  ProviderSummaries,
  SummaryMapper,
} from "../../provider-types";

/**
 * Approval-card summaries for every Outlook write action. Each mapper
 * returns the per-operation block in its **structural** form — i18n keys
 * and interpolation params, not display strings.
 *
 *  - `titleKey` resolves to `chatbot.approvals.outlook.<action>.title.<titleKey>`
 *    in `i18n/locales/<lang>.ts` (mostly `"default"`, multi-variant when an
 *    action needs several phrasings — see `respond_to_event`).
 *  - Each field's `labelKey` resolves under `external_apps.approvals.fields.*`.
 *  - Values are pure data (recipients, IDs, timestamps) and shown as-is.
 *
 * The backend renderer in `i18n/render-summary.ts` translates the
 * structural payload into display strings using the team's `lang`.
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

const shortId = (value: unknown): string => str(value).slice(0, 16);

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
  titleParams: { messageId: shortId(args.message_id) },
  fields: compact(
    field("message_id", str(args.message_id)),
    field("body", str(args.body_html), "html"),
    attachmentsField(args.attachments),
  ),
});

const replyAllEmail: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { messageId: shortId(args.message_id) },
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

const createDraft: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { recipients: recipientsParam(args.to) },
  fields: compact(
    emailsField("to", args.to),
    emailsField("cc", args.cc),
    field("subject", str(args.subject)),
    field("body", str(args.body_html), "html"),
    attachmentsField(args.attachments),
  ),
});

const updateDraft: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { draftId: shortId(args.message_id) },
  fields: compact(
    field("draft_id", str(args.message_id)),
    optionalField("new_subject", asString(args.subject)),
    optionalField("new_body", asString(args.body_html), "html"),
  ),
});

const deleteMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { messageId: shortId(args.message_id) },
  fields: [field("message_id", str(args.message_id))],
});

const moveMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { folderId: shortId(args.destination_folder_id) },
  fields: [
    field("message_id", str(args.message_id)),
    field("destination_folder", str(args.destination_folder_id)),
  ],
});

const copyMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { folderId: shortId(args.destination_folder_id) },
  fields: [
    field("message_id", str(args.message_id)),
    field("destination_folder", str(args.destination_folder_id)),
  ],
});

const markRead: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { messageId: shortId(args.message_id) },
  fields: [field("message_id", str(args.message_id))],
});

const markUnread: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { messageId: shortId(args.message_id) },
  fields: [field("message_id", str(args.message_id))],
});

const flagMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { messageId: shortId(args.message_id) },
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

// ── Calendar writes ────────────────────────────────────────────────────

const createCalendarEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: {
    subject: str(args.subject),
    start: str(args.start),
    end: str(args.end),
  },
  fields: compact(
    field("subject", str(args.subject)),
    field("start", str(args.start)),
    field("end", str(args.end)),
    optionalField("time_zone", asString(args.time_zone)),
    optionalField("location", asString(args.location)),
    emailsField("attendees", args.attendees),
    typeof args.is_online_meeting === "boolean"
      ? field("online_meeting", args.is_online_meeting ? "yes" : "no")
      : null,
    optionalField("body", asString(args.body_html), "html"),
  ),
});

const updateCalendarEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { eventId: shortId(args.event_id) },
  fields: compact(
    field("event_id", str(args.event_id)),
    optionalField("new_subject", asString(args.subject)),
    optionalField("new_start", asString(args.start)),
    optionalField("new_end", asString(args.end)),
    optionalField("time_zone", asString(args.time_zone)),
    optionalField("new_location", asString(args.location)),
    optionalField("new_body", asString(args.body_html), "html"),
  ),
});

const deleteCalendarEvent: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { eventId: shortId(args.event_id) },
  fields: [field("event_id", str(args.event_id))],
});

const respondToEvent: SummaryMapper = (args) => {
  const response = str(args.response);
  // Title variant per response so translators can phrase each idiomatically.
  const variant: string = ["accept", "decline", "tentativelyAccept"].includes(
    response,
  )
    ? response
    : "default";
  return {
    titleKey: variant,
    titleParams: { eventId: shortId(args.event_id) },
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

export const outlookSummaries: ProviderSummaries = {
  send_email: sendEmail,
  reply_email: replyEmail,
  reply_all_email: replyAllEmail,
  forward_email: forwardEmail,
  create_draft: createDraft,
  update_draft: updateDraft,
  delete_message: deleteMessage,
  move_message: moveMessage,
  copy_message: copyMessage,
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
