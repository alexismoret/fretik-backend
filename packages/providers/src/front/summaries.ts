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
 * Approval-card summaries for every Front write action. Each mapper
 * returns the per-operation block in its **structural** form — i18n
 * keys and interpolation params, not display strings.
 *
 *  - `titleKey` resolves to `chatbot.approvals.front.<action>.title.<titleKey>`
 *    in `i18n/locales/<lang>.ts`.
 *  - Each field's `labelKey` resolves under
 *    `external_apps.approvals.fields.*`.
 *
 * **User-friendly fields rule (ADDING_A_PROVIDER.md §8):** the
 * non-technical end-user reviews these cards. Skip opaque IDs — they
 * look like noise. Keep fields to things the user can visually verify
 * (recipients, subject, body, names, counts, human-readable statuses).
 * If every available field would be an ID, the title alone is the card.
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

const countField = (
  labelKey: string,
  value: unknown,
): ToolApprovalSummaryField | null => {
  const list = strArray(value);
  return list.length > 0 ? field(labelKey, list.length.toString()) : null;
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

// ── Conversation writes ───────────────────────────────────────────────

const replyToConversation: SummaryMapper = (args): OperationSummaryPart => ({
  titleKey: "default",
  fields: compact(
    emailsField("to", args.to),
    emailsField("cc", args.cc),
    emailsField("bcc", args.bcc),
    field("body", str(args.body_html), "html"),
    args.archive_after === true ? field("archive_after", "yes") : null,
    countField("tag_count", args.tag_ids_after),
    attachmentsField(args.attachments),
  ),
});

const sendNewMessage: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { recipients: recipientsParam(args.to) },
  fields: compact(
    emailsField("to", args.to),
    emailsField("cc", args.cc),
    emailsField("bcc", args.bcc),
    optionalField("subject", asString(args.subject)),
    field("body", str(args.body_html), "html"),
    countField("tag_count", args.tag_ids),
    attachmentsField(args.attachments),
  ),
});

const updateConversation: SummaryMapper = (args) => {
  const status = asString(args.status);
  const assignee = asString(args.assignee_id);
  const inbox = asString(args.inbox_id);
  // Pick the most specific title — status change drives the phrasing
  // when present, otherwise assignment, otherwise generic.
  let titleKey = "default";
  if (status !== undefined && status !== "") {
    titleKey =
      status === "archived"
        ? "archive"
        : status === "open"
          ? "reopen"
          : status === "deleted"
            ? "trash"
            : status === "spam"
              ? "spam"
              : "default";
  } else if (assignee !== undefined) {
    titleKey = assignee === "" ? "unassign" : "assign";
  } else if (inbox !== undefined && inbox !== "") {
    titleKey = "move";
  }
  return {
    titleKey,
    fields: compact(
      optionalField("new_status", status),
      // Assignment/inbox moves are surfaced through the title — fields
      // would otherwise be just an opaque id that means nothing to the
      // user. Skip them here.
    ),
  };
};

const deleteConversation: SummaryMapper = () => ({
  // No human-verifiable fields available — the title carries the
  // intent on its own (per ADDING_A_PROVIDER.md §8).
  titleKey: "default",
  fields: [],
});

const addConversationTags: SummaryMapper = (args) => {
  const ids = strArray(args.tag_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: [field("count", ids.length.toString())],
  };
};

const removeConversationTags: SummaryMapper = (args) => {
  const ids = strArray(args.tag_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: [field("count", ids.length.toString())],
  };
};

const addConversationComment: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    field("body", str(args.body), "html"),
    attachmentsField(args.attachments),
  ),
});

const snoozeConversation: SummaryMapper = (args) => {
  const scheduledAt = args.scheduled_at;
  // scheduled_at is a Unix epoch (seconds) integer — render as ISO 8601
  // for the human reviewing the card.
  const iso =
    typeof scheduledAt === "number"
      ? new Date(scheduledAt * 1000).toISOString()
      : String(scheduledAt);
  return {
    titleKey: "default",
    titleParams: { until: iso },
    fields: [field("scheduled_at", iso)],
  };
};

const unsnoozeConversation: SummaryMapper = () => ({
  titleKey: "default",
  fields: [],
});

const addConversationFollowers: SummaryMapper = (args) => {
  const ids = strArray(args.teammate_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: [field("count", ids.length.toString())],
  };
};

const removeConversationFollowers: SummaryMapper = (args) => {
  const ids = strArray(args.teammate_ids);
  return {
    titleKey: "default",
    titleParams: { count: ids.length.toString() },
    fields: [field("count", ids.length.toString())],
  };
};

// ── Contact writes ────────────────────────────────────────────────────

const handlesPreview = (value: unknown): string => {
  const items = arr(value);
  if (items.length === 0) return "";
  return items
    .map((h) => {
      const handle = str(prop(h, "handle"));
      const source = str(prop(h, "source"));
      return `${handle} (${source})`;
    })
    .join(", ");
};

const createContact: SummaryMapper = (args) => {
  const name = asString(args.name);
  return {
    titleKey: name !== undefined && name !== "" ? "withName" : "default",
    titleParams: { name: name ?? "" },
    fields: compact(
      optionalField("name", name),
      optionalField("description", asString(args.description)),
      (() => {
        const preview = handlesPreview(args.handles);
        return preview !== "" ? field("handles", preview) : null;
      })(),
    ),
  };
};

const updateContact: SummaryMapper = (args) => ({
  titleKey: "default",
  fields: compact(
    optionalField("name", asString(args.name)),
    optionalField("description", asString(args.description)),
    typeof args.is_spammer === "boolean"
      ? field("is_spammer", args.is_spammer ? "yes" : "no")
      : null,
  ),
});

// ── Tag writes ────────────────────────────────────────────────────────

const createTag: SummaryMapper = (args) => ({
  titleKey: "default",
  titleParams: { name: str(args.name) },
  fields: compact(
    field("tag_name", str(args.name)),
    optionalField("highlight", asString(args.highlight)),
  ),
});

const updateTag: SummaryMapper = (args) => {
  const newName = asString(args.name);
  return {
    titleKey: newName !== undefined && newName !== "" ? "withName" : "default",
    titleParams: { name: newName ?? "" },
    fields: compact(
      optionalField("tag_name", newName),
      optionalField("highlight", asString(args.highlight)),
    ),
  };
};

const deleteTag: SummaryMapper = () => ({
  // Tag ID alone is meaningless to the user; the title carries the
  // destructive intent. The agent already disambiguated the tag by name
  // in the chat turn before submitting the plan.
  titleKey: "default",
  fields: [],
});

export const frontSummaries: ProviderSummaries = {
  reply_to_conversation: replyToConversation,
  send_new_message: sendNewMessage,
  update_conversation: updateConversation,
  delete_conversation: deleteConversation,
  add_conversation_tags: addConversationTags,
  remove_conversation_tags: removeConversationTags,
  add_conversation_comment: addConversationComment,
  snooze_conversation: snoozeConversation,
  unsnooze_conversation: unsnoozeConversation,
  add_conversation_followers: addConversationFollowers,
  remove_conversation_followers: removeConversationFollowers,
  create_contact: createContact,
  update_contact: updateContact,
  create_tag: createTag,
  update_tag: updateTag,
  delete_tag: deleteTag,
};
