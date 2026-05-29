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

const replyAllEmail: SummaryMapper = (args) => ({
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

const updateDraft: SummaryMapper = (args) => {
  // When the agent updates the subject we use that in the title; if
  // they're only tweaking the body we keep the title generic to avoid
  // surfacing the opaque message id.
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
  // Pick the i18n title variant by status — fall back to "default" if
  // the agent passed an unrecognised string (Zod will already have
  // rejected at validate time, but be safe).
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
        optionalField("time_zone", asString(args.time_zone)),
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
      optionalField("time_zone", asString(args.time_zone)),
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
  // Title variant per response so translators can phrase each idiomatically.
  const variant: string = ["accept", "decline", "tentativelyAccept"].includes(
    response,
  )
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

// ── Inbox rules ────────────────────────────────────────────────────────

/**
 * Flatten the rule's conditions/actions into approval-card fields. We
 * surface only the conditions/actions actually set so the card reads
 * cleanly — empty fields are stripped via `compact`.
 */
const ruleConditionAndActionFields = (
  args: Record<string, unknown>,
): (ToolApprovalSummaryField | null)[] => [
  emailsField("from_addresses", args.from_addresses),
  (() => {
    const v = strArray(args.subject_contains);
    return v.length > 0 ? field("subject_contains", v.join(", ")) : null;
  })(),
  (() => {
    const v = strArray(args.body_contains);
    return v.length > 0 ? field("body_contains", v.join(", ")) : null;
  })(),
  typeof args.has_attachments === "boolean"
    ? field("has_attachments", args.has_attachments ? "yes" : "no")
    : null,
  optionalField("move_to_folder", asString(args.move_to_folder_id)),
  args.mark_as_read === true ? field("mark_as_read", "yes") : null,
  args.auto_delete === true ? field("auto_delete", "yes") : null,
];

const createInboxRule: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.display_name) },
  fields: compact(
    field("display_name", str(args.display_name)),
    typeof args.sequence === "number"
      ? field("sequence", args.sequence.toString())
      : null,
    typeof args.is_enabled === "boolean"
      ? field("is_enabled", args.is_enabled ? "yes" : "no")
      : null,
    ...ruleConditionAndActionFields(args),
  ),
});

const updateInboxRule: SummaryMapper = (args) => {
  const name = asString(args.display_name);
  if (name !== undefined && name !== "") {
    return {
      titleKey: "withName",
      titleParams: { name },
      fields: compact(
        field("rule_id", str(args.rule_id)),
        field("new_display_name", name),
        typeof args.sequence === "number"
          ? field("new_sequence", args.sequence.toString())
          : null,
        typeof args.is_enabled === "boolean"
          ? field("new_is_enabled", args.is_enabled ? "yes" : "no")
          : null,
        ...ruleConditionAndActionFields(args),
      ),
    };
  }
  return {
    titleKey: "default",
    fields: compact(
      field("rule_id", str(args.rule_id)),
      typeof args.sequence === "number"
        ? field("new_sequence", args.sequence.toString())
        : null,
      typeof args.is_enabled === "boolean"
        ? field("new_is_enabled", args.is_enabled ? "yes" : "no")
        : null,
      ...ruleConditionAndActionFields(args),
    ),
  };
};

const deleteInboxRule: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: [field("rule_id", str(args.rule_id))],
});

// ── Batch summaries (count-aware) ─────────────────────────────────────
//
// Mirror the IMAP `*_messages` cards: one approval row no matter how
// many ids, title = "Delete N messages", fields show count + the first
// 5 ids for spot-check.

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
  create_inbox_rule: createInboxRule,
  update_inbox_rule: updateInboxRule,
  delete_inbox_rule: deleteInboxRule,
  delete_messages: deleteMessages,
  move_messages: moveMessages,
  mark_messages_read: markMessagesRead,
  mark_messages_unread: markMessagesUnread,
};
