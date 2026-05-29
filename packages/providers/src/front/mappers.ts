import {
  arr,
  asNumber,
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
  RequestMapper,
  ResponseMapper,
} from "@fretik/shared/external-apps/provider-types";

/**
 * Front Core API request/response transformers.
 *
 * Front returns HAL-style payloads: list endpoints respond with
 * `{ _pagination: { next: <URL> }, _links, _results: [...] }` and the
 * next-page cursor is embedded in the URL's `page_token` query
 * parameter. The mappers below unwrap that into a clean
 * `page_token: string | undefined` exposed to the agent on every list
 * action, and accept the same `page_token` back as a query param.
 *
 * Request mappers reshape the manifest's snake_case args into Front's
 * camelCase / nested body / `q[...]` query model. Response mappers
 * normalize Front's payloads (camelCase, _links, nested objects) into
 * the snake_case shapes declared in `manifest.types`.
 */

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Front cursor pagination: `_pagination.next` is a full URL whose
 * `page_token` query param resumes the listing. The mapper either
 * follows the URL via `nango.proxy(baseUrlOverride=...)` (too brittle)
 * or extracts the token from the URL and lets the regular endpoint do
 * the work. We do the latter.
 */
const extractNextPageToken = (raw: unknown): string | undefined => {
  const next = asString(path(raw, "_pagination", "next"));
  if (next === undefined) return undefined;
  try {
    const url = new URL(next);
    const token = url.searchParams.get("page_token");
    return token === null ? undefined : token;
  } catch {
    return undefined;
  }
};

/**
 * Shared mapper for any read action whose paging is just `limit` +
 * `page_token` straight in the query. Drops empties so Front sees a
 * clean URL.
 */
const listWithPaging: RequestMapper = (args) => {
  const query: Record<string, string> = {};
  const limit = asNumber(args.limit);
  if (limit !== undefined) query.limit = limit.toString();
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.page_token = token;
  return { query };
};

const recipients = (handles: string[]): unknown[] =>
  handles.map((handle) => ({ handle }));

const fileAttachments = (value: unknown): unknown[] =>
  arr(value).map((att) => ({
    name: str(prop(att, "name")),
    content_type: str(prop(att, "content_type")),
    content: str(prop(att, "content_base64")),
  }));

// ── Read request mappers ──────────────────────────────────────────────

const listConversations: RequestMapper = (args) => {
  const query: Record<string, string> = {};
  const limit = asNumber(args.limit);
  if (limit !== undefined) query.limit = limit.toString();
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.page_token = token;

  const status = asString(args.status);
  if (status !== undefined && status !== "" && status !== "all") {
    // Front accepts `q[statuses]=open|archived|deleted|spam` as the
    // canonical filter. `assigned` / `unassigned` are layered through
    // `q[statuses]=assigned`/`unassigned` (Front interprets them as
    // open-only subsets — see the Conversations reference).
    query["q[statuses][]"] = status;
  }

  const inboxId = asString(args.inbox_id);
  if (inboxId !== undefined && inboxId !== "") {
    return {
      endpoint: `/inboxes/${encodeURIComponent(inboxId)}/conversations`,
      query,
    };
  }
  return { query };
};

const searchConversations: RequestMapper = (args) => {
  const query: Record<string, string> = {};
  const limit = asNumber(args.limit);
  if (limit !== undefined) query.limit = limit.toString();
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.page_token = token;
  return { query };
};

const findContact: RequestMapper = (args) => {
  const handle = str(args.handle);
  const query: Record<string, string> = {};
  const limit = asNumber(args.limit);
  if (limit !== undefined) query.limit = limit.toString();
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.page_token = token;
  // Rebuild the endpoint with a URL-encoded `from:<handle>` query.
  // Front's search path takes the query inline.
  return {
    endpoint: `/conversations/search/${encodeURIComponent(`from:${handle}`)}`,
    query,
  };
};

const listContacts: RequestMapper = (args) => {
  const query: Record<string, string> = {};
  const limit = asNumber(args.limit);
  if (limit !== undefined) query.limit = limit.toString();
  const token = asString(args.page_token);
  if (token !== undefined && token !== "") query.page_token = token;
  const after = asNumber(args.updated_after);
  if (after !== undefined) query["q[updated_after]"] = after.toString();
  const before = asNumber(args.updated_before);
  if (before !== undefined) query["q[updated_before]"] = before.toString();
  return { query };
};

// ── Write request mappers ─────────────────────────────────────────────

const replyToConversation: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    body: str(args.body_html),
  };
  const text = asString(args.text);
  if (text !== undefined) body.text = text;
  const channelId = asString(args.channel_id);
  if (channelId !== undefined && channelId !== "") body.channel_id = channelId;
  const to = strArray(args.to);
  if (to.length > 0) body.to = to;
  const cc = strArray(args.cc);
  if (cc.length > 0) body.cc = cc;
  const bcc = strArray(args.bcc);
  if (bcc.length > 0) body.bcc = bcc;
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) body.attachments = attachments;

  const options: Record<string, unknown> = {};
  if (bool(args.archive_after)) options.archive = true;
  const tagIdsAfter = strArray(args.tag_ids_after);
  if (tagIdsAfter.length > 0) options.tag_ids = tagIdsAfter;
  if (Object.keys(options).length > 0) body.options = options;

  return { body };
};

const sendNewMessage: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    to: recipients(strArray(args.to)),
    body: str(args.body_html),
  };
  const text = asString(args.text);
  if (text !== undefined) body.text = text;
  const cc = strArray(args.cc);
  if (cc.length > 0) body.cc = recipients(cc);
  const bcc = strArray(args.bcc);
  if (bcc.length > 0) body.bcc = recipients(bcc);
  const subject = asString(args.subject);
  if (subject !== undefined) body.subject = subject;
  const senderName = asString(args.sender_name);
  if (senderName !== undefined) body.sender_name = senderName;
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) body.attachments = attachments;
  const tagIds = strArray(args.tag_ids);
  if (tagIds.length > 0) body.options = { tag_ids: tagIds };
  return { body };
};

const updateConversation: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const status = asString(args.status);
  if (status !== undefined && status !== "") body.status = status;
  const assigneeId = args.assignee_id;
  if (typeof assigneeId === "string") {
    // Empty string means "unassign" — Front accepts `assignee_id: null`
    // for that.
    body.assignee_id = assigneeId === "" ? null : assigneeId;
  }
  const inboxId = asString(args.inbox_id);
  if (inboxId !== undefined && inboxId !== "") body.inbox_id = inboxId;
  return { body };
};

const tagIdsBody: RequestMapper = (args) => ({
  body: { tag_ids: strArray(args.tag_ids) },
});

const teammateIdsBody: RequestMapper = (args) => ({
  body: { teammate_ids: strArray(args.teammate_ids) },
});

const addComment: RequestMapper = (args) => {
  const body: Record<string, unknown> = { body: str(args.body) };
  const attachments = fileAttachments(args.attachments);
  if (attachments.length > 0) body.attachments = attachments;
  return { body };
};

const snoozeConversation: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    scheduled_at: num(args.scheduled_at),
  };
  const teammateId = asString(args.teammate_id);
  if (teammateId !== undefined && teammateId !== "") {
    body.teammate_id = teammateId;
  }
  return { body };
};

const unsnoozeConversation: RequestMapper = (args) => {
  const teammateId = asString(args.teammate_id);
  if (teammateId === undefined || teammateId === "") return { body: {} };
  return { body: { teammate_id: teammateId } };
};

const createContact: RequestMapper = (args) => {
  const body: Record<string, unknown> = {
    handles: arr(args.handles).map((h) => ({
      handle: str(prop(h, "handle")),
      source: str(prop(h, "source")),
    })),
  };
  const name = asString(args.name);
  if (name !== undefined) body.name = name;
  const description = asString(args.description);
  if (description !== undefined) body.description = description;
  const links = strArray(args.links);
  if (links.length > 0) body.links = links;
  if (typeof args.is_spammer === "boolean") body.is_spammer = args.is_spammer;
  return { body };
};

const updateContact: RequestMapper = (args) => {
  const body: Record<string, unknown> = {};
  const name = asString(args.name);
  if (name !== undefined) body.name = name;
  const description = asString(args.description);
  if (description !== undefined) body.description = description;
  if (typeof args.is_spammer === "boolean") body.is_spammer = args.is_spammer;
  const links = strArray(args.links);
  if (links.length > 0) body.links = links;
  return { body };
};

const tagBodyShared = (
  args: Record<string, unknown>,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  const name = asString(args.name);
  if (name !== undefined) body.name = name;
  const highlight = asString(args.highlight);
  if (highlight !== undefined) body.highlight = highlight;
  const parent = asString(args.parent_tag_id);
  if (parent !== undefined && parent !== "") body.parent_tag_id = parent;
  if (typeof args.is_visible_in_conversation_lists === "boolean") {
    body.is_visible_in_conversation_lists =
      args.is_visible_in_conversation_lists;
  }
  return body;
};

const createTag: RequestMapper = (args) => ({ body: tagBodyShared(args) });
const updateTag: RequestMapper = (args) => ({ body: tagBodyShared(args) });

// ── Response normalizers ──────────────────────────────────────────────

const normalizeInbox = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: str(path(raw, "name")),
  type: asString(path(raw, "type")),
  is_private: bool(path(raw, "is_private")),
  send_as: asString(path(raw, "send_as")),
});

const normalizeTeammate = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  email: str(path(raw, "email")),
  username: str(path(raw, "username")),
  first_name: asString(path(raw, "first_name")),
  last_name: asString(path(raw, "last_name")),
  is_available: bool(path(raw, "is_available")),
  is_admin: bool(path(raw, "is_admin")),
});

const normalizeTag = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: str(path(raw, "name")),
  highlight: asString(path(raw, "highlight")),
  is_private: bool(path(raw, "is_private")),
  is_visible_in_conversation_lists: bool(
    path(raw, "is_visible_in_conversation_lists"),
  ),
  parent_tag_id: asString(path(raw, "_links", "related", "parent_tag")),
});

const normalizeHandles = (value: unknown): unknown[] =>
  arr(value).map((h) => ({
    handle: str(prop(h, "handle")),
    source: str(prop(h, "source")),
  }));

const normalizeContact = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: asString(path(raw, "name")),
  description: asString(path(raw, "description")),
  handles: normalizeHandles(path(raw, "handles")),
  links: arr(path(raw, "links"))
    .map((l) => asString(prop(l, "external_url")) ?? asString(l) ?? "")
    .filter((s) => s !== ""),
  updated_at: asString(path(raw, "updated_at")),
});

/** Extract `id` from the `_links.related.assignee` URL. */
const idFromLink = (value: unknown): string | undefined => {
  const url = asString(value);
  if (url === undefined) return undefined;
  // Front _links are URLs ending in the resource id, e.g.
  // `https://api2.frontapp.com/teammates/tea_abc`. Take the last
  // segment that isn't empty.
  const segments = url.split("/").filter((s) => s !== "");
  const last = segments[segments.length - 1];
  return last === undefined || last === "" ? undefined : last;
};

const tagIdsFromLinks = (raw: unknown): string[] => {
  // Conversations include `tags: [...]` inline with full objects; fall
  // back to the `_links.related.tags` reference URL if absent.
  const inline = arr(path(raw, "tags"))
    .map((t) => asString(prop(t, "id")))
    .filter((s): s is string => s !== undefined);
  return inline;
};

const inboxIdsFrom = (raw: unknown): string[] => {
  // Conversation payloads expose `_links.related.inboxes` (a URL) and
  // sometimes `inboxes: [...]` inline. Prefer inline when present.
  const inline = arr(path(raw, "inboxes"))
    .map((i) => asString(prop(i, "id")))
    .filter((s): s is string => s !== undefined);
  if (inline.length > 0) return inline;
  // Last_message.is_inbound stays useful even without inboxes; return
  // empty when nothing inline is available.
  return [];
};

const normalizeConversation = (raw: unknown): Record<string, unknown> => {
  const lastMessage = path(raw, "last_message");
  const recipient = path(raw, "recipient");
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    subject: asString(path(raw, "subject")),
    status: str(path(raw, "status")),
    assignee_id: asString(path(raw, "assignee", "id")),
    recipient_handle: asString(path(recipient, "handle")),
    tag_ids: tagIdsFromLinks(raw),
    inbox_ids: inboxIdsFrom(raw),
    last_message_preview: asString(path(lastMessage, "blurb")),
    last_message_at: (() => {
      const createdAt = asNumber(path(lastMessage, "created_at"));
      return createdAt !== undefined
        ? new Date(createdAt * 1000).toISOString()
        : undefined;
    })(),
    created_at: (() => {
      const createdAt = asNumber(path(raw, "created_at"));
      return createdAt !== undefined
        ? new Date(createdAt * 1000).toISOString()
        : undefined;
    })(),
  };
  const mergedInto = asString(path(raw, "merged_into_conversation_id"));
  if (mergedInto !== undefined) out.merged_into_conversation_id = mergedInto;
  return out;
};

const normalizeMessage = (raw: unknown): Record<string, unknown> => {
  const msgRecipients = arr(path(raw, "recipients"));
  const to = msgRecipients
    .filter((r) => str(prop(r, "role")) === "to")
    .map((r) => str(prop(r, "handle")))
    .filter((h) => h !== "");
  const cc = msgRecipients
    .filter((r) => str(prop(r, "role")) === "cc")
    .map((r) => str(prop(r, "handle")))
    .filter((h) => h !== "");
  return {
    id: str(path(raw, "id")),
    type: str(path(raw, "type")),
    is_inbound: bool(path(raw, "is_inbound")),
    is_draft: bool(path(raw, "is_draft")),
    subject: asString(path(raw, "subject")),
    from_handle:
      asString(path(raw, "author", "email")) ??
      asString(
        msgRecipients
          .filter((r) => str(prop(r, "role")) === "from")
          .map((r) => str(prop(r, "handle")))[0],
      ),
    to,
    cc,
    body_html: str(path(raw, "body")),
    text: asString(path(raw, "text")),
    created_at: (() => {
      const createdAt = asNumber(path(raw, "created_at"));
      return createdAt !== undefined
        ? new Date(createdAt * 1000).toISOString()
        : undefined;
    })(),
  };
};

const normalizeComment = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  author_id: asString(path(raw, "author", "id")),
  body: str(path(raw, "body")),
  created_at: (() => {
    const createdAt = asNumber(path(raw, "posted_at"));
    return createdAt !== undefined
      ? new Date(createdAt * 1000).toISOString()
      : undefined;
  })(),
});

const normalizeEvent = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  type: str(path(raw, "type")),
  emitted_at: (() => {
    const emittedAt = asNumber(path(raw, "emitted_at"));
    return emittedAt !== undefined
      ? new Date(emittedAt * 1000).toISOString()
      : undefined;
  })(),
  source_id: idFromLink(path(raw, "_links", "related", "source")),
  target_id: idFromLink(path(raw, "_links", "related", "target")),
});

const normalizeRule = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  name: str(path(raw, "name")),
  is_private: bool(path(raw, "is_private")),
  actions: strArray(path(raw, "actions")),
});

// ── List wrappers ─────────────────────────────────────────────────────

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) => {
    const items = arr(path(raw, "_results")).map(normalize);
    const token = extractNextPageToken(raw);
    return token !== undefined ? { items, page_token: token } : { items };
  };

const inboxList = listOf(normalizeInbox);
const teammateList = listOf(normalizeTeammate);
const tagList = listOf(normalizeTag);
const conversationList = listOf(normalizeConversation);
const messageList = listOf(normalizeMessage);
const commentList = listOf(normalizeComment);
const eventList = listOf(normalizeEvent);
const contactList = listOf(normalizeContact);
const ruleList = listOf(normalizeRule);

/**
 * `find_contact` returns the `recipient` block of each conversation
 * matched by `from:<handle>` — we synthesise a Contact-shaped row out
 * of it so the agent doesn't need a second call just to read names.
 * The contact id comes from `_links.related.contact` (a URL whose last
 * segment is the contact id).
 */
const findContactResult: ResponseMapper = (raw) => {
  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const conv of arr(path(raw, "_results"))) {
    const recipient = path(conv, "recipient");
    const handle = str(prop(recipient, "handle"));
    if (handle === "") continue;
    const contactId =
      idFromLink(path(recipient, "_links", "related", "contact")) ?? "";
    const key = `${contactId}|${handle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      id: contactId,
      name: asString(prop(recipient, "name")),
      description: undefined,
      handles: [{ handle, source: "email" }],
      links: [],
      updated_at: undefined,
    });
  }
  const token = extractNextPageToken(raw);
  return token !== undefined ? { items, page_token: token } : { items };
};

// ── Single-resource responses ─────────────────────────────────────────

const conversation: ResponseMapper = normalizeConversation;
const contact: ResponseMapper = normalizeContact;
const tag: ResponseMapper = normalizeTag;
const rule: ResponseMapper = normalizeRule;

const writeResult: ResponseMapper = (raw) => ({
  id: isRecord(raw) ? asString(raw.id) : undefined,
});

const empty: ResponseMapper = () => ({});

// ── Export ────────────────────────────────────────────────────────────

export const frontMappers: ProviderMappers = {
  request: {
    listWithPaging,
    listConversations,
    searchConversations,
    findContact,
    listContacts,
    replyToConversation,
    sendNewMessage,
    updateConversation,
    tagIdsBody,
    teammateIdsBody,
    addComment,
    snoozeConversation,
    unsnoozeConversation,
    createContact,
    updateContact,
    createTag,
    updateTag,
  },
  response: {
    inboxList,
    teammateList,
    tagList,
    conversationList,
    messageList,
    commentList,
    eventList,
    contactList,
    ruleList,
    findContactResult,
    conversation,
    contact,
    tag,
    rule,
    writeResult,
    empty,
  },
};
