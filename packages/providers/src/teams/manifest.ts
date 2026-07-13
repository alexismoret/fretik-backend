import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Microsoft Teams provider manifest — 20 actions covering chats, channels,
 * messages, search, presence, and file attachments via Microsoft Graph v1.0.
 *
 * Decisions documented in `je-veux-ajouter-un-kind-kurzweil.md`:
 *  - Backed by the Nango `microsoft-teams` provider (delegated user
 *    permissions). NOT `microsoft-teams-bot` — no bot identity required.
 *  - Calendar / meeting endpoints are NOT exposed — Outlook owns calendar;
 *    duplicating would conflict with `<external_apps>` disambiguation.
 *  - `download_message_attachment` returns `download_url` (a pre-authed
 *    OneDrive direct link) instead of `content_base64`. Microsoft Graph
 *    has no Teams-attachment endpoint that returns base64 inline, and the
 *    `nango-proxy` transport can't chain a binary fetch. The agent uses
 *    `urllib.request.urlopen(download_url)` in the Python sandbox to
 *    materialise the file — see `guidance.md`.
 *
 * Several Graph scopes (`*.Read.All`) require tenant admin consent — the
 * manifest opts into the admin-consent UX via `requiresAdminConsent: true`.
 */
export const teamsManifest: ProviderManifest = {
  key: "teams",
  displayName: "Microsoft Teams",
  description:
    "Microsoft Teams — read and send chat messages, and manage meetings and calls on the user's connected Teams account.",
  nangoProviderConfigKey: "microsoft-teams",
  icon: "i-logos-microsoft-teams",
  iconColor: "#5059C9",
  transport: { kind: "nango-proxy" },
  // First slug ("communication") is the frontend filter root. Fine slugs
  // tell the agent this provider substitutes for any "message" / "video
  // call" request. Explicitly NOT `calendar` — Outlook owns it.
  categories: ["communication", "instant-messaging", "video-call"],
  // ChannelMessage.Read.All, TeamMember.Read.All, Channel.ReadBasic.All,
  // Team.ReadBasic.All, Presence.Read.All, User.ReadBasic.All and
  // Files.Read.All typically require tenant admin consent in business
  // Microsoft 365 tenants. The flag drives the "Install for the whole
  // organization" toggle + the friendly AADSTS error UI on the modal.
  requiresAdminConsent: true,
  connectionOptions: {
    fields: [
      {
        key: "persona",
        labelKey: "settings.externalApps.options.persona.label",
        helpKey: "settings.externalApps.options.persona.help",
        kind: "select",
        required: true,
        default: "personal",
        options: [
          {
            value: "personal",
            labelKey: "settings.externalApps.options.persona.personal",
            descriptionKey:
              "settings.externalApps.options.persona.personalHelp",
          },
          {
            value: "bot",
            labelKey: "settings.externalApps.options.persona.bot",
            descriptionKey: "settings.externalApps.options.persona.botHelp",
          },
        ],
        exposeToAgent: true,
      },
    ],
  },
  // 12 delegated scopes — all are documented Microsoft Graph delegated
  // permissions. Nango's `microsoft-teams` provider uses `.default`, so
  // every scope configured on the Azure App Registration is requested at
  // OAuth time. The Nango dashboard's scope picker shows a curated subset
  // of "common" scopes but does NOT restrict what's actually passable —
  // `User.*` and `Files.*` work fine once added to the Azure app + the
  // Nango integration's scope list.
  scopes: [
    "offline_access",
    // Identifies the signed-in user (Graph `/me`).
    "User.Read",
    // Directory search for `find_user` — least-privilege variant.
    "User.ReadBasic.All",
    // Chats — covers list/get chats, list members, list/get/send
    // messages, and create chat. (ChatMember.Read below is redundant
    // with Chat.ReadWrite but kept per the original scope list to
    // avoid re-prompting tenant admins.)
    "Chat.ReadWrite",
    "ChatMember.Read",
    // Teams hierarchy — list joined teams, get team metadata.
    "Team.ReadBasic.All",
    // Team membership listing.
    "TeamMember.Read.All",
    // Channel listing inside a team.
    "Channel.ReadBasic.All",
    // Channel messages — read + search.
    "ChannelMessage.Read.All",
    // Channel messages — write (does NOT need admin consent on its own).
    "ChannelMessage.Send",
    // Presence for self + others.
    "Presence.Read.All",
    // OneDrive/SharePoint files referenced as Teams attachments.
    "Files.Read.All",
  ],

  types: {
    Chat: {
      id: { type: "string" },
      topic: { type: "string", optional: true },
      chat_type: {
        type: "enum",
        values: ["oneOnOne", "group", "meeting", "unknownFutureValue"],
        description: "Chat kind — 1:1 DM, group DM, or a meeting chat",
      },
      last_updated_at: { type: "datetime" },
      web_url: { type: "string", optional: true },
    },
    ChatMember: {
      id: { type: "string" },
      display_name: { type: "string" },
      email: { type: "string", optional: true },
      user_id: {
        type: "string",
        optional: true,
        description:
          "Azure AD user ID — use as `member_user_ids[]` of `create_chat`",
      },
      roles: { type: "array", items: { type: "string" } },
    },
    ChatMessage: {
      id: { type: "string" },
      body_html: {
        type: "string",
        description:
          "Raw content — HTML when contentType=html, plain text otherwise",
      },
      from_user: {
        type: "string",
        description: "Display name of the sender (empty for system messages)",
      },
      from_user_id: {
        type: "string",
        optional: true,
        description: "Azure AD user ID of the sender",
      },
      created_at: { type: "datetime" },
      importance: { type: "string", optional: true },
      attachments: {
        type: "array",
        items: { type: "object", fields: { id: { type: "string" } } },
        optional: true,
        description:
          "Attachment metadata — pass `content_url` to `download_message_attachment` to resolve the binary.",
      },
    },
    Team: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string", optional: true },
      visibility: {
        type: "enum",
        values: ["private", "public", "hiddenMembership", "unknownFutureValue"],
      },
      web_url: { type: "string", optional: true },
    },
    Channel: {
      id: { type: "string" },
      display_name: { type: "string" },
      description: { type: "string", optional: true },
      membership_type: {
        type: "enum",
        values: ["standard", "private", "shared", "unknownFutureValue"],
      },
      web_url: { type: "string", optional: true },
    },
    ChannelMessage: {
      id: { type: "string" },
      subject: { type: "string", optional: true },
      body_html: { type: "string" },
      from_user: { type: "string" },
      from_user_id: { type: "string", optional: true },
      created_at: { type: "datetime" },
      web_url: { type: "string", optional: true },
      attachments: {
        type: "array",
        items: { type: "object", fields: { id: { type: "string" } } },
        optional: true,
      },
    },
    TeamMember: {
      id: { type: "string" },
      display_name: { type: "string" },
      email: { type: "string", optional: true },
      user_id: { type: "string", optional: true },
      roles: { type: "array", items: { type: "string" } },
    },
    Presence: {
      id: { type: "string" },
      availability: {
        type: "string",
        description:
          "Available, AvailableIdle, Busy, BusyIdle, DoNotDisturb, Away, BeRightBack, Offline, PresenceUnknown",
      },
      activity: { type: "string" },
    },
    User: {
      id: { type: "string" },
      display_name: { type: "string" },
      email: { type: "string", optional: true },
      user_principal_name: { type: "string", optional: true },
    },
    /**
     * Attachment shape — mirrors Outlook/IMAP-SMTP for cross-provider
     * uniformity. Teams attachments diverge on one point: Microsoft
     * Graph does not return file bytes inline as base64 for Teams, so
     * `download_message_attachment` populates `download_url` (a short-
     * lived OneDrive pre-authed direct link) instead of `content_base64`.
     * The agent fetches that URL from Python (see guidance.md).
     */
    Attachment: {
      id: { type: "string" },
      name: { type: "string" },
      content_type: { type: "string" },
      size_bytes: { type: "integer", optional: true },
      content_url: {
        type: "string",
        optional: true,
        description:
          "OneDrive/SharePoint sharing link as it appears on a Teams message attachment. Pass to `download_message_attachment(content_url=...)`.",
      },
      download_url: {
        type: "string",
        optional: true,
        description:
          "Short-lived pre-authenticated OneDrive direct download URL. Fetch with `urllib.request.urlopen(...)` and write to `/workspace/attachments/<name>` from the Python sandbox.",
      },
      sandbox_path: {
        type: "string",
        optional: true,
        description:
          "On-disk path inside the sandbox when an attachment binary has been written locally. Always `None` on Teams downloads — see `download_url`.",
      },
      content_base64: {
        type: "string",
        optional: true,
        description:
          "Always `None` on Teams downloads — Microsoft Graph does not return Teams attachment bytes inline. Use `download_url`.",
      },
    },
    SearchHit: {
      kind: { type: "enum", values: ["chat", "channel"] },
      chat_id: { type: "string", optional: true },
      team_id: { type: "string", optional: true },
      channel_id: { type: "string", optional: true },
      message_id: { type: "string" },
      body_preview: { type: "string" },
      from_user: { type: "string" },
      created_at: { type: "datetime" },
      web_url: { type: "string", optional: true },
    },
    WriteResult: {
      id: { type: "string", optional: true },
    },
  },

  actions: [
    // ─────────────────────────── Chats ─────────────────────────────
    {
      name: "list_chats",
      kind: "read",
      summary: "List the user's recent 1:1, group, and meeting chats",
      endpoint: { method: "GET", path: "/v1.0/me/chats" },
      params: {
        limit: { type: "integer", min: 1, max: 50, default: 20 },
      },
      returns: { list: "Chat" },
      request: "listWithTop",
      response: "chatList",
    },
    {
      name: "get_chat",
      kind: "read",
      summary: "Fetch one chat by ID",
      endpoint: { method: "GET", path: "/v1.0/chats/{chat_id}" },
      params: { chat_id: { type: "string", in: "path" } },
      returns: { ref: "Chat" },
      response: "chat",
    },
    {
      name: "list_chat_members",
      kind: "read",
      summary: "List the members of a chat",
      endpoint: { method: "GET", path: "/v1.0/chats/{chat_id}/members" },
      params: { chat_id: { type: "string", in: "path" } },
      returns: { list: "ChatMember" },
      response: "chatMemberList",
    },
    {
      name: "list_chat_messages",
      kind: "read",
      summary: "List recent messages in a chat (newest first)",
      endpoint: { method: "GET", path: "/v1.0/chats/{chat_id}/messages" },
      params: {
        chat_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 50, default: 20 },
      },
      returns: { list: "ChatMessage" },
      request: "listWithTop",
      response: "chatMessageList",
    },
    {
      name: "get_chat_message",
      kind: "read",
      summary: "Fetch one chat message by ID",
      endpoint: {
        method: "GET",
        path: "/v1.0/chats/{chat_id}/messages/{message_id}",
      },
      params: {
        chat_id: { type: "string", in: "path" },
        message_id: { type: "string", in: "path" },
      },
      returns: { ref: "ChatMessage" },
      response: "chatMessage",
    },
    {
      name: "send_chat_message",
      kind: "write",
      summary: "Post a message to a 1:1, group, or meeting chat",
      endpoint: { method: "POST", path: "/v1.0/chats/{chat_id}/messages" },
      params: {
        chat_id: { type: "string", in: "path" },
        body_html: {
          type: "string",
          excludeFromHash: true,
          description: "Message body — HTML or plain text",
        },
        inline_images: {
          type: "array",
          optional: true,
          excludeFromHash: true,
          description:
            "Inline images (image/png, image/jpeg, image/gif, max ~4MB each) embedded as base64. Appended after body_html as <img> tags. Non-image files cannot be sent.",
          items: {
            type: "object",
            fields: {
              name: { type: "string" },
              content_type: { type: "string" },
              content_base64: { type: "string", excludeFromHash: true },
            },
          },
        },
      },
      returns: { ref: "WriteResult" },
      request: "sendChatMessage",
      response: "writeResult",
    },
    {
      name: "create_chat",
      kind: "write",
      summary: "Create a 1:1 or group chat with one or more users",
      endpoint: { method: "POST", path: "/v1.0/chats" },
      params: {
        member_user_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Azure AD user IDs to add (NOT emails — use `find_user` first). The signed-in user is included implicitly.",
        },
        topic: {
          type: "string",
          optional: true,
          description:
            "Title — only used when more than two members (group chat)",
        },
      },
      returns: { ref: "Chat" },
      request: "createChat",
      response: "chat",
    },

    // ──────────────────────── Teams & channels ─────────────────────
    {
      name: "list_joined_teams",
      kind: "read",
      summary: "List every team the user belongs to",
      endpoint: { method: "GET", path: "/v1.0/me/joinedTeams" },
      params: {},
      returns: { list: "Team" },
      response: "teamList",
    },
    {
      name: "get_team",
      kind: "read",
      summary: "Fetch one team by ID",
      endpoint: { method: "GET", path: "/v1.0/teams/{team_id}" },
      params: { team_id: { type: "string", in: "path" } },
      returns: { ref: "Team" },
      response: "team",
    },
    {
      name: "list_team_members",
      kind: "read",
      summary: "List the members of a team",
      endpoint: { method: "GET", path: "/v1.0/teams/{team_id}/members" },
      params: { team_id: { type: "string", in: "path" } },
      returns: { list: "TeamMember" },
      response: "teamMemberList",
    },
    {
      name: "list_channels",
      kind: "read",
      summary: "List the channels inside a team",
      endpoint: { method: "GET", path: "/v1.0/teams/{team_id}/channels" },
      params: { team_id: { type: "string", in: "path" } },
      returns: { list: "Channel" },
      response: "channelList",
    },

    // ───────────────────────── Channel messages ────────────────────
    {
      name: "list_channel_messages",
      kind: "read",
      summary: "List recent top-level messages in a channel (newest first)",
      endpoint: {
        method: "GET",
        path: "/v1.0/teams/{team_id}/channels/{channel_id}/messages",
      },
      params: {
        team_id: { type: "string", in: "path" },
        channel_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 50, default: 20 },
      },
      returns: { list: "ChannelMessage" },
      request: "listWithTop",
      response: "channelMessageList",
    },
    {
      name: "get_channel_message",
      kind: "read",
      summary: "Fetch one channel message by ID",
      endpoint: {
        method: "GET",
        path: "/v1.0/teams/{team_id}/channels/{channel_id}/messages/{message_id}",
      },
      params: {
        team_id: { type: "string", in: "path" },
        channel_id: { type: "string", in: "path" },
        message_id: { type: "string", in: "path" },
      },
      returns: { ref: "ChannelMessage" },
      response: "channelMessage",
    },
    {
      name: "list_channel_message_replies",
      kind: "read",
      summary: "List the replies of a channel thread (oldest first)",
      endpoint: {
        method: "GET",
        path: "/v1.0/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
      },
      params: {
        team_id: { type: "string", in: "path" },
        channel_id: { type: "string", in: "path" },
        message_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 50, default: 20 },
      },
      returns: { list: "ChannelMessage" },
      request: "listWithTop",
      response: "channelMessageList",
    },
    {
      name: "send_channel_message",
      kind: "write",
      summary: "Post a new top-level message in a channel",
      endpoint: {
        method: "POST",
        path: "/v1.0/teams/{team_id}/channels/{channel_id}/messages",
      },
      params: {
        team_id: { type: "string", in: "path" },
        channel_id: { type: "string", in: "path" },
        body_html: { type: "string", excludeFromHash: true },
        subject: {
          type: "string",
          optional: true,
          description:
            "Optional thread title — shown in bold above the message body",
        },
        inline_images: {
          type: "array",
          optional: true,
          excludeFromHash: true,
          description:
            "Inline images (image/png, image/jpeg, image/gif, max ~4MB each) embedded as base64. Appended after body_html as <img> tags. Non-image files cannot be sent.",
          items: {
            type: "object",
            fields: {
              name: { type: "string" },
              content_type: { type: "string" },
              content_base64: { type: "string", excludeFromHash: true },
            },
          },
        },
      },
      returns: { ref: "WriteResult" },
      request: "sendChannelMessage",
      response: "writeResult",
    },
    {
      name: "reply_to_channel_message",
      kind: "write",
      summary: "Reply inside an existing channel thread (preserves the thread)",
      endpoint: {
        method: "POST",
        path: "/v1.0/teams/{team_id}/channels/{channel_id}/messages/{message_id}/replies",
      },
      params: {
        team_id: { type: "string", in: "path" },
        channel_id: { type: "string", in: "path" },
        message_id: { type: "string", in: "path" },
        body_html: { type: "string", excludeFromHash: true },
        inline_images: {
          type: "array",
          optional: true,
          excludeFromHash: true,
          description:
            "Inline images (image/png, image/jpeg, image/gif, max ~4MB each) embedded as base64. Appended after body_html as <img> tags. Non-image files cannot be sent.",
          items: {
            type: "object",
            fields: {
              name: { type: "string" },
              content_type: { type: "string" },
              content_base64: { type: "string", excludeFromHash: true },
            },
          },
        },
      },
      returns: { ref: "WriteResult" },
      request: "sendChannelMessage",
      response: "writeResult",
    },

    // ────────────────────────── Search & people ─────────────────────
    {
      name: "search_messages",
      kind: "read",
      summary:
        "Full-text search across chat AND channel messages (single Graph call)",
      endpoint: { method: "POST", path: "/v1.0/search/query" },
      params: {
        query: {
          type: "string",
          description:
            "Free-text query — KQL syntax supported. MUST be non-empty; Microsoft Graph rejects empty queries with HTTP 400. To browse without a search, use `list_chats` / `list_channel_messages` instead.",
        },
        limit: { type: "integer", min: 1, max: 25, default: 10 },
      },
      returns: { list: "SearchHit" },
      request: "searchMessages",
      response: "searchHits",
    },
    {
      name: "find_user",
      kind: "read",
      summary: "Look up users in the tenant by name or email prefix",
      endpoint: { method: "GET", path: "/v1.0/users" },
      params: {
        query: {
          type: "string",
          description: "Name fragment or email prefix",
        },
        limit: { type: "integer", min: 1, max: 25, default: 10 },
      },
      returns: { list: "User" },
      request: "findUser",
      response: "userList",
    },

    // ────────────────────────────── Presence ────────────────────────
    {
      name: "get_user_presence",
      kind: "read",
      summary:
        "Get the availability of a user (defaults to the signed-in user)",
      // Manifest path is the /me default; the request mapper overrides
      // the endpoint to `/v1.0/users/{user_id}/presence` when `user_id`
      // is provided. Same convention outlook uses for `calendar_id`.
      endpoint: { method: "GET", path: "/v1.0/me/presence" },
      params: {
        user_id: {
          type: "string",
          optional: true,
          description:
            "Azure AD user ID from `find_user`. Omit for the signed-in user.",
        },
      },
      returns: { ref: "Presence" },
      request: "getUserPresence",
      response: "presence",
    },

    // ─────────────────────────── Attachments ────────────────────────
    {
      name: "download_message_attachment",
      kind: "read",
      summary:
        "Resolve a Teams attachment sharing link to a direct download URL",
      // Manifest path is a placeholder — the request mapper rebuilds it
      // from the base64url-encoded `content_url`. Graph's `/shares/u!{}/`
      // endpoint dereferences a sharing URL to its underlying driveItem,
      // whose `@microsoft.graph.downloadUrl` is a short-lived pre-authed
      // direct download URL.
      endpoint: { method: "GET", path: "/v1.0/shares/_/driveItem" },
      params: {
        content_url: {
          type: "string",
          description:
            "Sharing URL from `ChatMessage.attachments[].content_url` / `ChannelMessage.attachments[].content_url`",
        },
      },
      returns: { ref: "Attachment" },
      request: "downloadMessageAttachment",
      response: "attachmentDownload",
    },
  ],
};
