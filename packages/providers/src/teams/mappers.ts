import {
  arr,
  asNumber,
  asString,
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
 * Microsoft Graph request/response transformers for the Teams provider.
 *
 * Request mappers turn the manifest's clean snake_case args into the Graph
 * request body/query. Response mappers normalize Graph's camelCase payloads
 * back into the snake_case shapes declared in the manifest `types`.
 */

// ── Selects ────────────────────────────────────────────────────────────

const CHAT_SELECT = "id,topic,chatType,lastUpdatedDateTime,webUrl";
const CHAT_MESSAGE_SELECT =
  "id,createdDateTime,from,body,importance,attachments";
const CHANNEL_MESSAGE_SELECT =
  "id,subject,createdDateTime,from,body,webUrl,attachments";
const TEAM_SELECT = "id,displayName,description,visibility,webUrl";
const CHANNEL_SELECT = "id,displayName,description,membershipType,webUrl";
const USER_SELECT = "id,displayName,mail,userPrincipalName";

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Base64-url encode a UTF-8 string per RFC 4648 §5 (no padding, `+`→`-`,
 * `/`→`_`). Microsoft Graph's `/shares/u!{token}` endpoint expects this
 * exact encoding of the sharing URL.
 */
const base64UrlEncode = (input: string): string =>
  Buffer.from(input, "utf-8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

/**
 * Apply a `$top` query param from the args' `limit` field. Most list
 * endpoints in Graph share this shape — pull it into one mapper instead
 * of repeating the same 3 lines on every list action.
 */
const listWithTop: RequestMapper = (args) => ({
  query: { $top: num(args.limit, 20).toString() },
});

const htmlBody = (content: string): Record<string, unknown> => ({
  contentType: "html",
  content,
});

/**
 * Build the chatMessage / channelMessage request body. Inline images go
 * through Microsoft Graph's `hostedContents[]` shape — each image gets a
 * temporary ID, the `<img>` tag is appended to the HTML body referencing
 * that ID, and the bytes ride inline as `contentBytes`. Single Graph
 * call, no OneDrive ceremony. Max ~4 MB per image (Graph limit). Files
 * other than images cannot be sent — see guidance.md.
 */
const buildMessageBody = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> => {
  const images = arr(args.inline_images);
  let html = str(args.body_html);
  const hostedContents: unknown[] = [];
  images.forEach((img, idx) => {
    const tempId = (idx + 1).toString();
    const contentType = str(prop(img, "content_type"));
    const contentBytes = str(prop(img, "content_base64"));
    if (contentBytes === "") return;
    hostedContents.push({
      "@microsoft.graph.temporaryId": tempId,
      contentBytes,
      contentType,
    });
    html += `<p><img src="../hostedContents/${tempId}/$value"></p>`;
  });
  const out: Record<string, unknown> = {
    body: htmlBody(html),
    ...extra,
  };
  if (hostedContents.length > 0) out.hostedContents = hostedContents;
  return out;
};

// ── Request mappers — writes ───────────────────────────────────────────

const sendChatMessage: RequestMapper = (args) => ({
  body: buildMessageBody(args, {}),
});

const sendChannelMessage: RequestMapper = (args) => {
  const extra: Record<string, unknown> = {};
  const subject = asString(args.subject);
  if (subject !== undefined && subject !== "") extra.subject = subject;
  return { body: buildMessageBody(args, extra) };
};

const createChat: RequestMapper = (args) => {
  const memberIds = strArray(args.member_user_ids);
  const topic = asString(args.topic);
  // The signed-in user is added by Graph automatically when omitted; we
  // pass only the requested participants. `chatType` is implicit: 2
  // members → oneOnOne, ≥3 → group (Graph picks).
  const members = memberIds.map((id) => ({
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${id}')`,
    roles: ["owner"],
  }));
  const body: Record<string, unknown> = {
    chatType: memberIds.length >= 2 ? "group" : "oneOnOne",
    members,
  };
  if (topic !== undefined && topic !== "" && memberIds.length >= 2) {
    body.topic = topic;
  }
  return { body };
};

// ── Request mappers — search + people + presence ───────────────────────

const searchMessages: RequestMapper = (args) => ({
  body: {
    requests: [
      {
        entityTypes: ["chatMessage"],
        query: { queryString: str(args.query) },
        from: 0,
        size: num(args.limit, 10),
      },
    ],
  },
});

const findUser: RequestMapper = (args) => {
  // `$search` would require a `ConsistencyLevel: eventual` header which
  // the proxy abstraction doesn't forward. `$filter` with `startswith`
  // covers prefix search on displayName + mail without needing extra
  // headers, and is sufficient for "find Alice" lookups.
  const q = str(args.query).replace(/'/g, "''");
  const filter = `startswith(displayName,'${q}') or startswith(mail,'${q}') or startswith(userPrincipalName,'${q}')`;
  return {
    query: {
      $filter: filter,
      $top: num(args.limit, 10).toString(),
      $select: USER_SELECT,
    },
  };
};

const getUserPresence: RequestMapper = (args) => {
  const userId = asString(args.user_id);
  if (userId !== undefined && userId !== "") {
    return {
      endpoint: `/v1.0/users/${encodeURIComponent(userId)}/presence`,
    };
  }
  return {};
};

const downloadMessageAttachment: RequestMapper = (args) => {
  const url = str(args.content_url);
  const token = `u!${base64UrlEncode(url)}`;
  // `?$select=...` lets us pull `@microsoft.graph.downloadUrl` in the
  // same call as `name` + `size` + `file.mimeType`.
  return {
    endpoint: `/v1.0/shares/${token}/driveItem`,
    query: {
      $select: "id,name,size,file,@microsoft.graph.downloadUrl",
    },
  };
};

// ── Response mappers ───────────────────────────────────────────────────

const normalizeChat = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  topic: asString(path(raw, "topic")),
  chat_type: str(path(raw, "chatType"), "unknownFutureValue"),
  last_updated_at: str(path(raw, "lastUpdatedDateTime")),
  web_url: asString(path(raw, "webUrl")),
});

const normalizeChatMember = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  email: asString(path(raw, "email")),
  user_id: asString(path(raw, "userId")),
  roles: strArray(path(raw, "roles")),
});

const normalizeAttachmentRef = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    content_type: str(path(raw, "contentType")),
  };
  const url = asString(path(raw, "contentUrl"));
  if (url !== undefined) out.content_url = url;
  return out;
};

const normalizeAttachments = (raw: unknown): Record<string, unknown>[] =>
  arr(raw).map(normalizeAttachmentRef);

const normalizeChatMessage = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    body_html: str(path(raw, "body", "content")),
    from_user: str(path(raw, "from", "user", "displayName")),
    created_at: str(path(raw, "createdDateTime")),
  };
  const fromUserId = asString(path(raw, "from", "user", "id"));
  if (fromUserId !== undefined) out.from_user_id = fromUserId;
  const importance = asString(path(raw, "importance"));
  if (importance !== undefined) out.importance = importance;
  const atts = normalizeAttachments(path(raw, "attachments"));
  if (atts.length > 0) out.attachments = atts;
  return out;
};

const normalizeChannelMessage = (raw: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    body_html: str(path(raw, "body", "content")),
    from_user: str(path(raw, "from", "user", "displayName")),
    created_at: str(path(raw, "createdDateTime")),
  };
  const subject = asString(path(raw, "subject"));
  if (subject !== undefined && subject !== "") out.subject = subject;
  const fromUserId = asString(path(raw, "from", "user", "id"));
  if (fromUserId !== undefined) out.from_user_id = fromUserId;
  const webUrl = asString(path(raw, "webUrl"));
  if (webUrl !== undefined) out.web_url = webUrl;
  const atts = normalizeAttachments(path(raw, "attachments"));
  if (atts.length > 0) out.attachments = atts;
  return out;
};

const normalizeTeam = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  description: asString(path(raw, "description")),
  visibility: str(path(raw, "visibility"), "unknownFutureValue"),
  web_url: asString(path(raw, "webUrl")),
});

const normalizeChannel = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  description: asString(path(raw, "description")),
  membership_type: str(path(raw, "membershipType"), "unknownFutureValue"),
  web_url: asString(path(raw, "webUrl")),
});

const normalizeTeamMember = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  email: asString(path(raw, "email")),
  user_id: asString(path(raw, "userId")),
  roles: strArray(path(raw, "roles")),
});

const normalizePresence = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  availability: str(path(raw, "availability"), "PresenceUnknown"),
  activity: str(path(raw, "activity"), "Unknown"),
});

const normalizeUser = (raw: unknown): Record<string, unknown> => ({
  id: str(path(raw, "id")),
  display_name: str(path(raw, "displayName")),
  email: asString(path(raw, "mail")),
  user_principal_name: asString(path(raw, "userPrincipalName")),
});

const writeResult: ResponseMapper = (raw) => {
  const id = asString(prop(raw, "id"));
  return id !== undefined ? { id } : {};
};

const listOf =
  (normalize: (raw: unknown) => Record<string, unknown>): ResponseMapper =>
  (raw) =>
    arr(path(raw, "value")).map(normalize);

const chatList = listOf(normalizeChat);
const chatMessageList = listOf(normalizeChatMessage);
const chatMemberList = listOf(normalizeChatMember);
const channelMessageList = listOf(normalizeChannelMessage);
const teamList = listOf(normalizeTeam);
const channelList = listOf(normalizeChannel);
const teamMemberList = listOf(normalizeTeamMember);
const userList = listOf(normalizeUser);

/**
 * Microsoft Graph `/search/query` returns
 * `{ value: [{ hitsContainers: [{ hits: [{ resource: <chatMessage> }] }] }] }`.
 * We flatten this into a single SearchHit list, classifying each by the
 * presence of `channelIdentity` (channel message) vs `chatId` (chat
 * message) on the resource.
 */
const searchHits: ResponseMapper = (raw): Record<string, unknown>[] => {
  // Graph's response is `{ value: [{ hitsContainers: [...] }] }` — `value`
  // is an array of `searchResponse` objects keyed by `requests[]`. We
  // submitted exactly one request, so we read index 0.
  const firstResponse = arr(path(raw, "value"))[0];
  const hitContainers =
    firstResponse !== undefined
      ? arr(path(firstResponse, "hitsContainers"))
      : [];
  const out: Record<string, unknown>[] = [];
  for (const container of hitContainers) {
    for (const hit of arr(path(container, "hits"))) {
      const resource = path(hit, "resource");
      const channelIdentity = path(resource, "channelIdentity");
      const isChannel =
        channelIdentity !== undefined && channelIdentity !== null;
      const item: Record<string, unknown> = {
        kind: isChannel ? "channel" : "chat",
        message_id: str(path(resource, "id")),
        body_preview: str(path(hit, "summary")),
        from_user: str(path(resource, "from", "user", "displayName")),
        created_at: str(path(resource, "createdDateTime")),
      };
      if (isChannel) {
        item.team_id = str(path(channelIdentity, "teamId"));
        item.channel_id = str(path(channelIdentity, "channelId"));
      } else {
        const chatId = asString(path(resource, "chatId"));
        if (chatId !== undefined) item.chat_id = chatId;
      }
      const webUrl = asString(path(resource, "webUrl"));
      if (webUrl !== undefined) item.web_url = webUrl;
      out.push(item);
    }
  }
  return out;
};

/**
 * Normalise a Graph `driveItem` response into an `Attachment`. Microsoft
 * publishes the pre-authed direct download URL as the special property
 * `@microsoft.graph.downloadUrl` (note the leading `@` and dots).
 */
const attachmentDownload: ResponseMapper = (raw): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    id: str(path(raw, "id")),
    name: str(path(raw, "name")),
    content_type: str(path(raw, "file", "mimeType")),
  };
  const size = asNumber(path(raw, "size"));
  if (size !== undefined) out.size_bytes = size;
  const downloadUrl = asString(prop(raw, "@microsoft.graph.downloadUrl"));
  if (downloadUrl !== undefined) out.download_url = downloadUrl;
  return out;
};

// ── Selects baked into the per-action mappers ──────────────────────────
//
// (Kept as exported `$select` constants in case future mappers want to
// narrow further. Not exported individually — they're inlined in the
// generic listWithTop where needed.)
void CHAT_SELECT;
void CHAT_MESSAGE_SELECT;
void CHANNEL_MESSAGE_SELECT;
void TEAM_SELECT;
void CHANNEL_SELECT;

export const teamsMappers: ProviderMappers = {
  request: {
    listWithTop,
    sendChatMessage,
    sendChannelMessage,
    createChat,
    searchMessages,
    findUser,
    getUserPresence,
    downloadMessageAttachment,
  },
  response: {
    chat: normalizeChat,
    chatList,
    chatMemberList,
    chatMessage: normalizeChatMessage,
    chatMessageList,
    channelMessage: normalizeChannelMessage,
    channelMessageList,
    team: normalizeTeam,
    teamList,
    teamMemberList,
    channelList,
    presence: normalizePresence,
    userList,
    searchHits,
    attachmentDownload,
    writeResult,
  },
};
