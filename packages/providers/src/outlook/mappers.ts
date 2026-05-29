import {
  arr,
  asString,
  bool,
  isRecord,
  num,
  path,
  prop,
  str,
  strArray,
} from "@fretik/shared/external-apps/json-access";
import type {
  ProviderMappers,
  ProxyRequestParts,
  RequestMapper,
  ResponseMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Microsoft Graph request/response transformers for the Outlook provider.
 *
 * Request mappers turn the manifest's clean snake_case args into the Graph
 * request body/query. Response mappers normalize Graph's camelCase payloads
 * back into the snake_case shapes declared in the manifest `types`.
 */

// ── Graph shape builders ───────────────────────────────────────────────

const recipients = (emails: string[]): unknown[] =>
  emails.map((address) => ({ emailAddress: { address } }));

const htmlBody = (content: string): Record<string, unknown> => ({
  contentType: "HTML",
  content,
});

/** Build Graph `fileAttachment` items from agent-side attachment params. */
const fileAttachments = (value: unknown): unknown[] =>
  arr(value).map((att) => ({
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: str(prop(att, "name")),
    contentType: str(prop(att, "content_type")),
    contentBytes: str(prop(att, "content_base64")),
  }));

const MESSAGE_SELECT =
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,bodyPreview,webLink";
const EVENT_SELECT =
  "id,subject,start,end,location,organizer,attendees,isOnlineMeeting,bodyPreview,webLink";
const CONTACT_SELECT =
  "id,displayName,emailAddresses,companyName,jobTitle,mobilePhone";
const ATTACHMENT_META_SELECT = "id,name,contentType,size";

// ── Request mappers ────────────────────────────────────────────────────

const listMessages: RequestMapper = (args) => {
  const query: Record<string, string> = {
    $top: num(args.limit, 25).toString(),
    $select: MESSAGE_SELECT,
    $orderby: "receivedDateTime desc",
  };
  const offset = num(args.offset, 0);
  if (offset > 0) query.$skip = offset.toString();
  if (bool(args.unread_only)) query.$filter = "isRead eq false";
  return { query };
};

const searchMessages: RequestMapper = (args) => {
  const query: Record<string, string> = {
    $search: `"${str(args.query)}"`,
    $top: num(args.limit, 25).toString(),
    $select: MESSAGE_SELECT,
  };
  const offset = num(args.offset, 0);
  if (offset > 0) query.$skip = offset.toString();
  return { query };
};

const sendMail: RequestMapper = (args) => {
  const message: Record<string, unknown> = {
    subject: str(args.subject),
    body: htmlBody(str(args.body_html)),
    toRecipients: recipients(strArray(args.to)),
  };
  const cc = strArray(args.cc);
  if (cc.length > 0) message.ccRecipients = recipients(cc);
  const bcc = strArray(args.bcc);
  if (bcc.length > 0) message.bccRecipients = recipients(bcc);
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) message.attachments = attachments;
  return { body: { message, saveToSentItems: true } };
};

const replyMail: RequestMapper = (args) => {
  const message: Record<string, unknown> = {
    body: htmlBody(str(args.body_html)),
  };
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) message.attachments = attachments;
  return { body: { message } };
};

const forwardMail: RequestMapper = (args) => {
  const message: Record<string, unknown> = {};
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) message.attachments = attachments;
  const body: Record<string, unknown> = {
    toRecipients: recipients(strArray(args.to)),
  };
  if (Object.keys(message).length > 0) body.message = message;
  const comment = asString(args.comment);
  if (comment !== undefined) body.comment = comment;
  return { body };
};

const createDraft: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    subject: str(args.subject),
    body: htmlBody(str(args.body_html)),
    toRecipients: recipients(strArray(args.to)),
  };
  const cc = strArray(args.cc);
  if (cc.length > 0) body.ccRecipients = recipients(cc);
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) body.attachments = attachments;
  return { body };
};

const updateDraft: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const subject = asString(args.subject);
  if (subject !== undefined) body.subject = subject;
  const bodyHtml = asString(args.body_html);
  if (bodyHtml !== undefined) body.body = htmlBody(bodyHtml);
  return { body };
};

const moveCopyMessage: RequestMapper = (args) => ({
  body: { destinationId: str(args.destination_folder_id) },
});

// ── Graph $batch helpers ──────────────────────────────────────────────
//
// Graph caps a single `$batch` POST at 20 sub-requests. The agent-side
// SDK is documented to surface this — we slice defensively on the
// server side too so a 50-id call won't fan out into a 50-request
// payload that Graph rejects with HTTP 400. The remaining 30 ids are
// silently dropped; the agent chunks for >20 (see guidance.md).

const BATCH_MAX_REQUESTS = 20;

interface BatchSubRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}

const buildBatchRequest = (
  ids: string[],
  build: (id: string) => BatchSubRequest,
): ProxyRequestParts => {
  const clipped = ids.slice(0, BATCH_MAX_REQUESTS);
  return {
    body: {
      requests: clipped.map((id, i) => ({
        id: i.toString(),
        ...build(id),
      })),
    },
  };
};

const deleteMessagesBatch: RequestMapper = (args) =>
  buildBatchRequest(strArray(args.message_ids), (id) => ({
    method: "DELETE",
    url: `/me/messages/${encodeURIComponent(id)}`,
  }));

const moveMessagesBatch: RequestMapper = (args) => {
  const destination = str(args.destination_folder_id);
  return buildBatchRequest(strArray(args.message_ids), (id) => ({
    method: "POST",
    url: `/me/messages/${encodeURIComponent(id)}/move`,
    body: { destinationId: destination },
    headers: { "Content-Type": "application/json" },
  }));
};

const markMessagesReadBatch: RequestMapper = (args) =>
  buildBatchRequest(strArray(args.message_ids), (id) => ({
    method: "PATCH",
    url: `/me/messages/${encodeURIComponent(id)}`,
    body: { isRead: true },
    headers: { "Content-Type": "application/json" },
  }));

const markMessagesUnreadBatch: RequestMapper = (args) =>
  buildBatchRequest(strArray(args.message_ids), (id) => ({
    method: "PATCH",
    url: `/me/messages/${encodeURIComponent(id)}`,
    body: { isRead: false },
    headers: { "Content-Type": "application/json" },
  }));

const markRead: RequestMapper = () => ({ body: { isRead: true } });
const markUnread: RequestMapper = () => ({ body: { isRead: false } });
const flagMessage: RequestMapper = (args) => {
  const status = str(args.status, "flagged");
  const flag: Record<string, unknown> = { flagStatus: status };
  const due = asString(args.due_date);
  // dueDateTime only applies to "flagged" — Graph rejects it on
  // "notFlagged" / "complete". Silently drop it in those cases so the
  // agent can pass status+due_date defensively without erroring.
  if (status === "flagged" && due !== undefined) {
    flag.dueDateTime = { dateTime: due, timeZone: str(args.time_zone, "UTC") };
  }
  return { body: { flag } };
};

const createFolder: RequestMapper = (args) => {
  const parts: ProxyRequestParts = {
    body: { displayName: str(args.display_name) },
  };
  const parent = asString(args.parent_folder_id);
  if (parent !== undefined && parent !== "") {
    parts.endpoint = `/v1.0/me/mailFolders/${encodeURIComponent(parent)}/childFolders`;
  }
  return parts;
};

/** Force a metadata-only `$select` on attachment listings (no contentBytes). */
const listMessageAttachments: RequestMapper = () => ({
  query: { $select: ATTACHMENT_META_SELECT },
});

// ── Calendar path helper ───────────────────────────────────────────────
//
// When the agent passes `calendar_id`, every calendar action targets
// `/v1.0/me/calendars/{calendar_id}/<suffix>` instead of `/v1.0/me/<suffix>`.
// The mappers below build the full endpoint themselves, overriding the
// manifest's default path via the `endpoint` field of ProxyRequestParts.

const calendarBase = (args: Record<string, unknown>): string => {
  const id = asString(args.calendar_id);
  return id !== undefined && id !== ""
    ? `/v1.0/me/calendars/${encodeURIComponent(id)}`
    : `/v1.0/me`;
};

const listCalendarEvents: RequestMapper = (args) => {
  const query: Record<string, string> = {
    startDateTime: str(args.start),
    endDateTime: str(args.end),
    $top: num(args.limit, 50).toString(),
    $orderby: "start/dateTime",
    $select: EVENT_SELECT,
  };
  const offset = num(args.offset, 0);
  if (offset > 0) query.$skip = offset.toString();
  return {
    endpoint: `${calendarBase(args)}/calendarView`,
    query,
  };
};

const getCalendarEvent: RequestMapper = (args) => ({
  endpoint: `${calendarBase(args)}/events/${encodeURIComponent(str(args.event_id))}`,
});

const deleteCalendarEvent: RequestMapper = (args) => ({
  endpoint: `${calendarBase(args)}/events/${encodeURIComponent(str(args.event_id))}`,
});

const listEventInstances: RequestMapper = (args) => {
  const query: Record<string, string> = {
    startDateTime: str(args.start),
    endDateTime: str(args.end),
    $top: num(args.limit, 50).toString(),
    $orderby: "start/dateTime",
    $select: EVENT_SELECT,
  };
  const offset = num(args.offset, 0);
  if (offset > 0) query.$skip = offset.toString();
  return {
    endpoint: `${calendarBase(args)}/events/${encodeURIComponent(str(args.event_id))}/instances`,
    query,
  };
};

const eventBody = (
  args: Record<string, unknown>,
  includeRequired: boolean,
): Record<string, unknown> => {
  const tz = str(args.time_zone, "UTC");
  const body: Record<string, unknown> = {};
  if (includeRequired || asString(args.subject) !== undefined) {
    body.subject = str(args.subject);
  }
  const start = asString(args.start);
  if (start !== undefined) body.start = { dateTime: start, timeZone: tz };
  const end = asString(args.end);
  if (end !== undefined) body.end = { dateTime: end, timeZone: tz };
  const location = asString(args.location);
  if (location !== undefined) body.location = { displayName: location };
  const bodyHtml = asString(args.body_html);
  if (bodyHtml !== undefined) body.body = htmlBody(bodyHtml);
  const attendees = strArray(args.attendees);
  if (attendees.length > 0) {
    body.attendees = attendees.map((address) => ({
      emailAddress: { address },
      type: "required",
    }));
  }
  if (typeof args.is_online_meeting === "boolean") {
    body.isOnlineMeeting = args.is_online_meeting;
  }
  return body;
};

const createEvent: RequestMapper = (args) => ({
  endpoint: `${calendarBase(args)}/events`,
  body: eventBody(args, true),
});
const updateEvent: RequestMapper = (args) => ({
  endpoint: `${calendarBase(args)}/events/${encodeURIComponent(str(args.event_id))}`,
  body: eventBody(args, false),
});

const respondToEvent: RequestMapper = (args) => {
  const comment = asString(args.comment);
  return {
    endpoint: `${calendarBase(args)}/events/${encodeURIComponent(str(args.event_id))}/${str(args.response)}`,
    body: comment !== undefined ? { comment } : {},
  };
};

const listContacts: RequestMapper = (args) => {
  const query: Record<string, string> = {
    $top: num(args.limit, 50).toString(),
    $orderby: "displayName",
    $select: CONTACT_SELECT,
  };
  const offset = num(args.offset, 0);
  if (offset > 0) query.$skip = offset.toString();
  return { query };
};

const createContact: RequestMapper = (args) => {
  const body: Record<string, unknown> = { givenName: str(args.given_name) };
  const surname = asString(args.surname);
  if (surname !== undefined) body.surname = surname;
  const email = asString(args.email);
  if (email !== undefined && email !== "") {
    body.emailAddresses = [{ address: email, name: str(args.given_name) }];
  }
  const companyName = asString(args.company_name);
  if (companyName !== undefined) body.companyName = companyName;
  const jobTitle = asString(args.job_title);
  if (jobTitle !== undefined) body.jobTitle = jobTitle;
  const mobilePhone = asString(args.mobile_phone);
  if (mobilePhone !== undefined) body.mobilePhone = mobilePhone;
  return { body };
};

// ── Inbox rules ────────────────────────────────────────────────────────
//
// Microsoft Graph nests conditions/actions inside `conditions` /
// `actions` objects; our SDK keeps them flat for the agent. The
// helpers below assemble the nested shape on outbound writes and
// flatten it back on reads (see normalizeRule below).

/** Build the nested `{ conditions, actions }` Graph payload from our flat args. */
const buildRuleConditionsAndActions = (
  args: Record<string, unknown>,
): {
  conditions: Record<string, unknown>;
  actions: Record<string, unknown>;
} => {
  const conditions: Record<string, unknown> = {};
  const fromAddresses = strArray(args.from_addresses);
  if (fromAddresses.length > 0) {
    conditions.fromAddresses = recipients(fromAddresses);
  }
  const subjectContains = strArray(args.subject_contains);
  if (subjectContains.length > 0) conditions.subjectContains = subjectContains;
  const bodyContains = strArray(args.body_contains);
  if (bodyContains.length > 0) conditions.bodyContains = bodyContains;
  if (typeof args.has_attachments === "boolean") {
    conditions.hasAttachments = args.has_attachments;
  }

  const actions: Record<string, unknown> = {};
  const moveToFolder = asString(args.move_to_folder_id);
  if (moveToFolder !== undefined && moveToFolder !== "") {
    actions.moveToFolder = moveToFolder;
  }
  if (args.mark_as_read === true) actions.markAsRead = true;
  if (args.auto_delete === true) actions.delete = true;
  return { conditions, actions };
};

const createInboxRule: RequestMapper = (args) => {
  const { conditions, actions } = buildRuleConditionsAndActions(args);
  const body: Record<string, unknown> = {
    displayName: str(args.display_name),
    sequence: num(args.sequence, 1),
    isEnabled: typeof args.is_enabled === "boolean" ? args.is_enabled : true,
    conditions,
    actions,
  };
  return { body };
};

const updateInboxRule: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const displayName = asString(args.display_name);
  if (displayName !== undefined) body.displayName = displayName;
  if (typeof args.sequence === "number") body.sequence = args.sequence;
  if (typeof args.is_enabled === "boolean") body.isEnabled = args.is_enabled;

  // For PATCH, the API expects the full conditions/actions objects to
  // be sent if you want to change them — partial sub-field updates are
  // not supported by Microsoft Graph (sending `{ conditions: {
  // subjectContains: [...] } }` REPLACES the whole conditions object).
  // We mirror that: include conditions/actions only when at least one
  // sub-field was provided, so the agent can patch other top-level
  // fields (`is_enabled`, `sequence`, `display_name`) without
  // wiping the existing conditions/actions.
  const hasConditionPatch =
    args.from_addresses !== undefined ||
    args.subject_contains !== undefined ||
    args.body_contains !== undefined ||
    args.has_attachments !== undefined;
  const hasActionPatch =
    args.move_to_folder_id !== undefined ||
    args.mark_as_read !== undefined ||
    args.auto_delete !== undefined;
  if (hasConditionPatch || hasActionPatch) {
    const { conditions, actions } = buildRuleConditionsAndActions(args);
    if (hasConditionPatch) body.conditions = conditions;
    if (hasActionPatch) body.actions = actions;
  }
  return { body };
};

// ── Response mappers ───────────────────────────────────────────────────

const recipientAddresses = (value: unknown): string[] =>
  arr(value)
    .map((r) => str(path(r, "emailAddress", "address")))
    .filter((address) => address !== "");

const normalizeMessage = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  subject: str(path(raw, "subject")),
  from_address: str(path(raw, "from", "emailAddress", "address")),
  to: recipientAddresses(path(raw, "toRecipients")),
  received_at: str(path(raw, "receivedDateTime")),
  is_read: bool(path(raw, "isRead")),
  has_attachments: bool(path(raw, "hasAttachments")),
  body_preview: str(path(raw, "bodyPreview")),
  web_link: asString(path(raw, "webLink")),
});

const normalizeMessageFull = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  subject: str(path(raw, "subject")),
  from_address: str(path(raw, "from", "emailAddress", "address")),
  to: recipientAddresses(path(raw, "toRecipients")),
  cc: recipientAddresses(path(raw, "ccRecipients")),
  received_at: str(path(raw, "receivedDateTime")),
  is_read: bool(path(raw, "isRead")),
  has_attachments: bool(path(raw, "hasAttachments")),
  body_html: str(path(raw, "body", "content")),
  web_link: asString(path(raw, "webLink")),
});

const normalizeFolder = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  parent_folder_id: asString(path(raw, "parentFolderId")),
  total_item_count: num(path(raw, "totalItemCount")),
  unread_item_count: num(path(raw, "unreadItemCount")),
});

const normalizeEvent = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  subject: str(path(raw, "subject")),
  start: str(path(raw, "start", "dateTime")),
  end: str(path(raw, "end", "dateTime")),
  location: asString(path(raw, "location", "displayName")),
  organizer: asString(path(raw, "organizer", "emailAddress", "address")),
  attendees: recipientAddresses(path(raw, "attendees")),
  is_online_meeting: bool(path(raw, "isOnlineMeeting")),
  body_preview: asString(path(raw, "bodyPreview")),
  web_link: asString(path(raw, "webLink")),
});

const normalizeContact = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  email_addresses: arr(path(raw, "emailAddresses"))
    .map((e) => str(path(e, "address")))
    .filter((address) => address !== ""),
  company_name: asString(path(raw, "companyName")),
  job_title: asString(path(raw, "jobTitle")),
  mobile_phone: asString(path(raw, "mobilePhone")),
});

const normalizeCalendar = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: str(path(raw, "name")),
  is_default_calendar: bool(path(raw, "isDefaultCalendar")),
  can_edit: bool(path(raw, "canEdit")),
  color: asString(path(raw, "hexColor")),
  owner: asString(path(raw, "owner", "address")),
});

/** Metadata-only attachment (list — content_base64 omitted). */
const normalizeAttachmentMeta = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: str(path(raw, "name")),
  content_type: str(path(raw, "contentType")),
  size_bytes: num(path(raw, "size")),
});

/** Full attachment including base64 content (download). */
const normalizeAttachmentContent = (raw: unknown): Record<string, unknown> => ({
  ...normalizeAttachmentMeta(raw),
  content_base64: asString(path(raw, "contentBytes")),
});

/**
 * Flatten Microsoft Graph's nested `messageRule` into our InboxRule
 * shape (no nested `conditions`/`actions` objects). Omits conditions /
 * actions that aren't set on the rule so the agent doesn't have to
 * filter out empty arrays / false sentinels.
 */
const normalizeRule = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    display_name: str(path(raw, "displayName")),
    sequence: num(path(raw, "sequence")),
    is_enabled: bool(path(raw, "isEnabled")),
    is_read_only: bool(path(raw, "isReadOnly")),
  };
  const hasError = path(raw, "hasError");
  if (typeof hasError === "boolean") out.has_error = hasError;

  const fromAddresses = arr(path(raw, "conditions", "fromAddresses"))
    .map((r) => str(path(r, "emailAddress", "address")))
    .filter((address) => address !== "");
  if (fromAddresses.length > 0) out.from_addresses = fromAddresses;

  const subjectContains = strArray(path(raw, "conditions", "subjectContains"));
  if (subjectContains.length > 0) out.subject_contains = subjectContains;

  const bodyContains = strArray(path(raw, "conditions", "bodyContains"));
  if (bodyContains.length > 0) out.body_contains = bodyContains;

  const hasAttachments = path(raw, "conditions", "hasAttachments");
  if (typeof hasAttachments === "boolean") {
    out.has_attachments = hasAttachments;
  }

  const moveToFolder = asString(path(raw, "actions", "moveToFolder"));
  if (moveToFolder !== undefined && moveToFolder !== "") {
    out.move_to_folder_id = moveToFolder;
  }
  const markAsRead = path(raw, "actions", "markAsRead");
  if (typeof markAsRead === "boolean" && markAsRead) {
    out.mark_as_read = true;
  }
  const autoDelete = path(raw, "actions", "delete");
  if (typeof autoDelete === "boolean" && autoDelete) {
    out.auto_delete = true;
  }
  return out;
};

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) =>
    arr(path(raw, "value")).map(normalize);

const messageList = listOf(normalizeMessage);
const folderList = listOf(normalizeFolder);
const eventList = listOf(normalizeEvent);
const contactList = listOf(normalizeContact);
const attachmentList = listOf(normalizeAttachmentMeta);
const ruleList = listOf(normalizeRule);
const calendarList = listOf(normalizeCalendar);

const writeResult: ResponseMapper = (raw) => ({
  id: isRecord(raw) ? asString(raw.id) : undefined,
});

const empty: ResponseMapper = () => ({});

/**
 * Aggregate a Graph `$batch` response into a `BatchWriteResult[]`. Each
 * sub-response carries an `id` (the index we set on submission), a
 * `status` (HTTP code) and an optional error `body`. Partial failures
 * are kept in-line so the agent can retry just the failed sub-ops
 * without re-issuing the whole batch.
 */
const batchWriteResponse: ResponseMapper = (raw) => {
  const responses = arr(path(raw, "responses"));
  return responses.map((r) => {
    const idStr = str(path(r, "id"));
    const status = num(path(r, "status"));
    const ok = status >= 200 && status < 300;
    if (ok) return { id: idStr, ok: true };
    const message = asString(path(r, "body", "error", "message"));
    return {
      id: idStr,
      ok: false,
      error: message ?? `HTTP ${status.toString()}`,
    };
  });
};

export const outlookMappers: ProviderMappers = {
  request: {
    listMessages,
    searchMessages,
    sendMail,
    replyMail,
    forwardMail,
    createDraft,
    updateDraft,
    moveCopyMessage,
    markRead,
    markUnread,
    flagMessage,
    createFolder,
    listMessageAttachments,
    listCalendarEvents,
    createEvent,
    updateEvent,
    respondToEvent,
    listContacts,
    createContact,
    createInboxRule,
    updateInboxRule,
    deleteMessagesBatch,
    moveMessagesBatch,
    markMessagesReadBatch,
    markMessagesUnreadBatch,
    getCalendarEvent,
    deleteCalendarEvent,
    listEventInstances,
  },
  response: {
    messageList,
    messageFull: normalizeMessageFull,
    folderList,
    folder: normalizeFolder,
    eventList,
    event: normalizeEvent,
    contactList,
    contact: normalizeContact,
    attachmentList,
    attachmentContent: normalizeAttachmentContent,
    writeResult,
    empty,
    ruleList,
    rule: normalizeRule,
    batchWriteResponse,
    calendarList,
  },
};
