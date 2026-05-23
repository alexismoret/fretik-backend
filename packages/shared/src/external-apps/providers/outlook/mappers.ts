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
} from "../../json-access";
import type {
  ProviderMappers,
  ProxyRequestParts,
  RequestMapper,
  ResponseMapper,
} from "../../provider-types";

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
  if (bool(args.unread_only)) query.$filter = "isRead eq false";
  return { query };
};

const searchMessages: RequestMapper = (args) => ({
  query: {
    $search: `"${str(args.query)}"`,
    $top: num(args.limit, 25).toString(),
    $select: MESSAGE_SELECT,
  },
});

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

const markRead: RequestMapper = () => ({ body: { isRead: true } });
const markUnread: RequestMapper = () => ({ body: { isRead: false } });
const flagMessage: RequestMapper = () => ({
  body: { flag: { flagStatus: "flagged" } },
});

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

const listCalendarEvents: RequestMapper = (args) => ({
  query: {
    startDateTime: str(args.start),
    endDateTime: str(args.end),
    $top: num(args.limit, 50).toString(),
    $orderby: "start/dateTime",
    $select: EVENT_SELECT,
  },
});

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

const createEvent: RequestMapper = (args) => ({ body: eventBody(args, true) });
const updateEvent: RequestMapper = (args) => ({ body: eventBody(args, false) });

const respondToEvent: RequestMapper = (args) => {
  const comment = asString(args.comment);
  return { body: comment !== undefined ? { comment } : {} };
};

const listContacts: RequestMapper = (args) => ({
  query: {
    $top: num(args.limit, 50).toString(),
    $orderby: "displayName",
    $select: CONTACT_SELECT,
  },
});

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

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) =>
    arr(path(raw, "value")).map(normalize);

const messageList = listOf(normalizeMessage);
const folderList = listOf(normalizeFolder);
const eventList = listOf(normalizeEvent);
const contactList = listOf(normalizeContact);
const attachmentList = listOf(normalizeAttachmentMeta);

const writeResult: ResponseMapper = (raw) => ({
  id: isRecord(raw) ? asString(raw.id) : undefined,
});

const empty: ResponseMapper = () => ({});

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
  },
};
