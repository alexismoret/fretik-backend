import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Front (frontapp.com) provider manifest — 30 actions covering the
 * shared-inbox triage loop: list/search conversations, paginated thread
 * + comments + events, contacts CRUD, tags CRUD, rules (read-only),
 * reply, send new outbound message, conversation update (status /
 * assignee / inbox), tags add/remove, internal comments, snooze,
 * followers, and conversation delete.
 *
 * Source of truth for the generated Python SDK, the SKILL.md reference
 * and backend argument validation. Hand-authored against the Front Core
 * API v1 reference (https://dev.frontapp.com/reference) — every endpoint
 * is verified before merge.
 *
 * Front API base is `https://api2.frontapp.com` (Nango proxy resolves it
 * from the `front` provider config). OAuth 2.0 only; the authorizing
 * Front user must be an admin. Access tokens last 60 minutes — Nango
 * auto-refreshes through the refresh token.
 */
export const frontManifest: ProviderManifest = {
  key: "front",
  displayName: "Front",
  nangoProviderConfigKey: "front",
  // Local SVG asset — AppIcon.vue renders the file at
  // app/public/app-icons/front.svg via <img> with no tint applied.
  icon: "/app-icons/front.svg",
  transport: { kind: "nango-proxy" },
  // First slug ("communication") is the root used by the frontend
  // filter. Fine-grained slugs tell the agent this provider substitutes
  // for any "shared-inbox" / "email" request — e.g. for triage workflows
  // where Front competes with Outlook.
  categories: ["communication", "shared-inbox", "email"],
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
  // Front's OAuth scope set. Front docs note that for OAuth apps
  // targeting a single Front company (our typical customer) scopes are
  // advisory and the authorizing admin grants the union; we still
  // declare them for self-documentation and for public partner apps
  // where they are enforced.
  scopes: [
    "conversations:read",
    "conversations:write",
    "messages:read",
    "messages:send",
    "messages:write",
    "comments:read",
    "comments:write",
    "contacts:read",
    "contacts:write",
    "tags:read",
    "tags:write",
    "inboxes:read",
    "teammates:read",
    "channels:read",
  ],

  types: {
    Inbox: {
      id: { type: "string" },
      name: { type: "string" },
      type: {
        type: "string",
        optional: true,
        description: "Inbox type: smtp / imap / custom / twilio / …",
      },
      is_private: { type: "boolean" },
      send_as: {
        type: "string",
        optional: true,
        description: "Default sender handle the inbox replies from",
      },
    },
    Teammate: {
      id: { type: "string" },
      email: { type: "string" },
      username: { type: "string" },
      first_name: { type: "string", optional: true },
      last_name: { type: "string", optional: true },
      is_available: { type: "boolean" },
      is_admin: { type: "boolean" },
    },
    Tag: {
      id: { type: "string" },
      name: { type: "string" },
      highlight: {
        type: "string",
        optional: true,
        description:
          "Tag color highlight (grey, pink, red, orange, yellow, green, light-blue, blue, purple)",
      },
      is_private: { type: "boolean" },
      is_visible_in_conversation_lists: { type: "boolean" },
      parent_tag_id: { type: "string", optional: true },
    },
    Handle: {
      handle: {
        type: "string",
        description: "The address itself — email, phone, twitter handle, etc.",
      },
      source: {
        type: "string",
        description:
          "Channel source: email / phone / twitter / front_chat / custom",
      },
    },
    Contact: {
      id: { type: "string" },
      name: { type: "string", optional: true },
      description: { type: "string", optional: true },
      handles: {
        type: "array",
        items: {
          type: "object",
          fields: {
            handle: { type: "string" },
            source: { type: "string" },
          },
        },
      },
      links: {
        type: "array",
        items: { type: "string" },
        optional: true,
        description: "External URLs attached to the contact",
      },
      updated_at: { type: "datetime", optional: true },
    },
    Conversation: {
      id: { type: "string" },
      subject: { type: "string", optional: true },
      status: {
        type: "string",
        description: "open / archived / deleted / spam",
      },
      assignee_id: { type: "string", optional: true },
      recipient_handle: {
        type: "string",
        optional: true,
        description:
          "Handle (email / phone) of the external party of the conversation",
      },
      tag_ids: { type: "array", items: { type: "string" } },
      inbox_ids: { type: "array", items: { type: "string" } },
      last_message_preview: { type: "string", optional: true },
      last_message_at: { type: "datetime", optional: true },
      created_at: { type: "datetime", optional: true },
      merged_into_conversation_id: {
        type: "string",
        optional: true,
        description:
          "Populated when the conversation was merged — id of the surviving conversation",
      },
    },
    Message: {
      id: { type: "string" },
      type: {
        type: "string",
        description: "email / sms / tweet / chat / custom",
      },
      is_inbound: { type: "boolean" },
      is_draft: { type: "boolean" },
      subject: { type: "string", optional: true },
      from_handle: { type: "string", optional: true },
      to: { type: "array", items: { type: "string" } },
      cc: { type: "array", items: { type: "string" } },
      body_html: { type: "string" },
      text: { type: "string", optional: true },
      created_at: { type: "datetime", optional: true },
    },
    Comment: {
      id: { type: "string" },
      author_id: { type: "string", optional: true },
      body: { type: "string" },
      created_at: { type: "datetime", optional: true },
    },
    ConversationEvent: {
      id: { type: "string" },
      type: {
        type: "string",
        description:
          "Event kind: assigned / unassigned / archived / reopened / tagged / untagged / commented / inbound / outbound / …",
      },
      emitted_at: { type: "datetime", optional: true },
      source_id: {
        type: "string",
        optional: true,
        description: "Teammate id that triggered the event (when applicable)",
      },
      target_id: {
        type: "string",
        optional: true,
        description:
          "Target resource id (e.g. the teammate assigned, the tag added)",
      },
    },
    Rule: {
      id: { type: "string" },
      name: { type: "string" },
      is_private: { type: "boolean" },
      actions: {
        type: "array",
        items: { type: "string" },
        description: "List of action types the rule applies",
      },
    },
    WriteResult: {
      id: { type: "string", optional: true },
    },
  },

  actions: [
    // ───────────────────────── Reads ─────────────────────────
    {
      name: "list_inboxes",
      kind: "read",
      summary: "List the Front inboxes the connection can access",
      endpoint: { method: "GET", path: "/inboxes" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Inbox" },
      request: "listWithPaging",
      response: "inboxList",
    },
    {
      name: "list_teammates",
      kind: "read",
      summary: "List teammates in the Front company",
      endpoint: { method: "GET", path: "/teammates" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Teammate" },
      request: "listWithPaging",
      response: "teammateList",
    },
    {
      name: "list_tags",
      kind: "read",
      summary: "List company tags (used to resolve names to tag IDs)",
      endpoint: { method: "GET", path: "/tags" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Tag" },
      request: "listWithPaging",
      response: "tagList",
    },
    {
      name: "list_conversations",
      kind: "read",
      summary: "List conversations, optionally scoped to one inbox",
      // Default path; mapper rewrites to `/inboxes/{id}/conversations`
      // when `inbox_id` is set.
      endpoint: { method: "GET", path: "/conversations" },
      params: {
        inbox_id: {
          type: "string",
          optional: true,
          description: "Scope the listing to one inbox",
        },
        status: {
          type: "enum",
          values: [
            "open",
            "archived",
            "deleted",
            "spam",
            "assigned",
            "unassigned",
            "all",
          ],
          optional: true,
          description:
            "Filter by status. `assigned` / `unassigned` are convenience filters layered on top of `open`",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Conversation" },
      request: "listConversations",
      response: "conversationList",
    },
    {
      name: "search_conversations",
      kind: "read",
      summary: "Full-text search using Front search syntax",
      endpoint: {
        method: "GET",
        path: "/conversations/search/{query}",
      },
      params: {
        query: {
          type: "string",
          in: "path",
          description:
            "Front search expression — supports `is:`, `inbox:`, `tag:`, `assignee:`, `from:`, `to:`, `before:`, `after:`, `during:`, `custom_field:name=value`, and free-text terms",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Conversation" },
      request: "searchConversations",
      response: "conversationList",
    },
    {
      name: "get_conversation",
      kind: "read",
      summary: "Fetch conversation metadata (status, assignee, tags, …)",
      endpoint: { method: "GET", path: "/conversations/{conversation_id}" },
      params: {
        conversation_id: { type: "string", in: "path" },
      },
      returns: { ref: "Conversation" },
      response: "conversation",
    },
    {
      name: "list_conversation_messages",
      kind: "read",
      summary: "List messages in a conversation thread (paginated)",
      endpoint: {
        method: "GET",
        path: "/conversations/{conversation_id}/messages",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 100, default: 20 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Message" },
      request: "listWithPaging",
      response: "messageList",
    },
    {
      name: "list_conversation_comments",
      kind: "read",
      summary: "List internal comments (notes) on a conversation",
      endpoint: {
        method: "GET",
        path: "/conversations/{conversation_id}/comments",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Comment" },
      request: "listWithPaging",
      response: "commentList",
    },
    {
      name: "list_conversation_events",
      kind: "read",
      summary: "List the event history of a conversation (audit log)",
      endpoint: {
        method: "GET",
        path: "/conversations/{conversation_id}/events",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "ConversationEvent" },
      request: "listWithPaging",
      response: "eventList",
    },
    {
      name: "list_contacts",
      kind: "read",
      summary: "List contacts in the Front company",
      endpoint: { method: "GET", path: "/contacts" },
      params: {
        updated_after: {
          type: "integer",
          optional: true,
          description:
            "Filter contacts updated after this Unix epoch (seconds)",
        },
        updated_before: {
          type: "integer",
          optional: true,
          description:
            "Filter contacts updated before this Unix epoch (seconds)",
        },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Contact" },
      request: "listContacts",
      response: "contactList",
    },
    {
      name: "get_contact",
      kind: "read",
      summary: "Fetch one contact by ID",
      endpoint: { method: "GET", path: "/contacts/{contact_id}" },
      params: { contact_id: { type: "string", in: "path" } },
      returns: { ref: "Contact" },
      response: "contact",
    },
    {
      name: "find_contact",
      kind: "read",
      summary:
        "Find contacts by handle (email / phone) via conversation search",
      // Mapper rewrites the endpoint to
      // `/conversations/search/from:<handle>` because Front has no
      // /contacts/search endpoint. Returns the matching recipients
      // (each carries `handle` + `contact_id`).
      endpoint: { method: "GET", path: "/conversations/search/{query}" },
      params: {
        handle: {
          type: "string",
          description: "Email, phone, twitter handle, etc. to search for",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Contact" },
      request: "findContact",
      response: "findContactResult",
    },
    {
      name: "list_rules",
      kind: "read",
      summary: "List Front automation rules (read-only)",
      endpoint: { method: "GET", path: "/rules" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        page_token: { type: "string", optional: true },
      },
      returns: { page: "Rule" },
      request: "listWithPaging",
      response: "ruleList",
    },
    {
      name: "get_rule",
      kind: "read",
      summary: "Fetch one automation rule by ID",
      endpoint: { method: "GET", path: "/rules/{rule_id}" },
      params: { rule_id: { type: "string", in: "path" } },
      returns: { ref: "Rule" },
      response: "rule",
    },

    // ───────────────────────── Writes ─────────────────────────
    {
      name: "reply_to_conversation",
      kind: "write",
      summary: "Reply to a conversation thread",
      endpoint: {
        method: "POST",
        path: "/conversations/{conversation_id}/messages",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        body_html: { type: "string", excludeFromHash: true },
        text: {
          type: "string",
          optional: true,
          excludeFromHash: true,
          description:
            "Plain-text alternative (Front falls back to a stripped body when omitted)",
        },
        channel_id: {
          type: "string",
          optional: true,
          description:
            "Channel to send from. Defaults to the conversation's last reply-capable channel — pass explicitly when several channels are available to avoid surprises",
        },
        to: {
          type: "array",
          items: { type: "email" },
          optional: true,
          description: "Override the default recipients",
        },
        cc: { type: "array", items: { type: "email" }, optional: true },
        bcc: { type: "array", items: { type: "email" }, optional: true },
        archive_after: {
          type: "boolean",
          optional: true,
          description: "Archive the conversation after sending",
        },
        tag_ids_after: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description: "Add these tag IDs to the conversation after sending",
        },
        attachments: {
          type: "array",
          optional: true,
          excludeFromHash: true,
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
      request: "replyToConversation",
      response: "writeResult",
    },
    {
      name: "send_new_message",
      kind: "write",
      summary: "Send a new outbound message (starts a new conversation)",
      endpoint: {
        method: "POST",
        path: "/channels/{channel_id}/messages",
      },
      params: {
        channel_id: {
          type: "string",
          in: "path",
          description: "ID of the channel to send from",
        },
        to: { type: "array", items: { type: "email" } },
        cc: { type: "array", items: { type: "email" }, optional: true },
        bcc: { type: "array", items: { type: "email" }, optional: true },
        subject: { type: "string", optional: true },
        body_html: { type: "string", excludeFromHash: true },
        text: { type: "string", optional: true, excludeFromHash: true },
        sender_name: {
          type: "string",
          optional: true,
          description: "Display name shown to the recipient",
        },
        tag_ids: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description: "Tags to attach to the new conversation",
        },
        attachments: {
          type: "array",
          optional: true,
          excludeFromHash: true,
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
      request: "sendNewMessage",
      response: "writeResult",
    },
    {
      name: "update_conversation",
      kind: "write",
      summary:
        "Update conversation status, assignee, or inbox (archive / reopen / move / assign)",
      endpoint: { method: "PATCH", path: "/conversations/{conversation_id}" },
      params: {
        conversation_id: { type: "string", in: "path" },
        status: {
          type: "enum",
          values: ["open", "archived", "deleted", "spam"],
          optional: true,
        },
        assignee_id: {
          type: "string",
          optional: true,
          description:
            "Teammate ID to assign. Pass an empty string to unassign",
        },
        inbox_id: {
          type: "string",
          optional: true,
          description: "Move the conversation to this inbox",
        },
      },
      returns: { void: true },
      request: "updateConversation",
      response: "empty",
    },
    {
      name: "delete_conversation",
      kind: "write",
      summary: "Permanently delete a conversation",
      endpoint: { method: "DELETE", path: "/conversations/{conversation_id}" },
      params: { conversation_id: { type: "string", in: "path" } },
      returns: { void: true },
      response: "empty",
    },
    {
      name: "add_conversation_tags",
      kind: "write",
      summary: "Add tags to a conversation (additive)",
      endpoint: {
        method: "POST",
        path: "/conversations/{conversation_id}/tags",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        tag_ids: { type: "array", items: { type: "string" } },
      },
      returns: { void: true },
      request: "tagIdsBody",
      response: "empty",
    },
    {
      name: "remove_conversation_tags",
      kind: "write",
      summary: "Remove tags from a conversation",
      endpoint: {
        method: "DELETE",
        path: "/conversations/{conversation_id}/tags",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        tag_ids: { type: "array", items: { type: "string" } },
      },
      returns: { void: true },
      request: "tagIdsBody",
      response: "empty",
    },
    {
      name: "add_conversation_comment",
      kind: "write",
      summary: "Add an internal comment (note) to a conversation",
      endpoint: {
        method: "POST",
        path: "/conversations/{conversation_id}/comments",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        body: {
          type: "string",
          excludeFromHash: true,
          description:
            "Comment body — markdown, supports `@username` mentions resolved by Front",
        },
        attachments: {
          type: "array",
          optional: true,
          excludeFromHash: true,
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
      request: "addComment",
      response: "writeResult",
    },
    {
      name: "snooze_conversation",
      kind: "write",
      summary: "Snooze a conversation until a future timestamp",
      endpoint: {
        method: "POST",
        path: "/conversations/{conversation_id}/reminders",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        scheduled_at: {
          type: "integer",
          description: "Unix epoch (seconds) when the snooze should end",
        },
        teammate_id: {
          type: "string",
          optional: true,
          description:
            "Teammate the snooze is set for (defaults to the bot teammate)",
        },
      },
      returns: { void: true },
      request: "snoozeConversation",
      response: "empty",
    },
    {
      name: "unsnooze_conversation",
      kind: "write",
      summary: "Cancel an active snooze on a conversation",
      endpoint: {
        method: "DELETE",
        path: "/conversations/{conversation_id}/reminders",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        teammate_id: {
          type: "string",
          optional: true,
          description:
            "Teammate whose snooze should be cleared (defaults to the bot teammate)",
        },
      },
      returns: { void: true },
      request: "unsnoozeConversation",
      response: "empty",
    },
    {
      name: "add_conversation_followers",
      kind: "write",
      summary: "Add teammates as followers of a conversation",
      endpoint: {
        method: "POST",
        path: "/conversations/{conversation_id}/followers",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        teammate_ids: { type: "array", items: { type: "string" } },
      },
      returns: { void: true },
      request: "teammateIdsBody",
      response: "empty",
    },
    {
      name: "remove_conversation_followers",
      kind: "write",
      summary: "Remove teammates from the followers of a conversation",
      endpoint: {
        method: "DELETE",
        path: "/conversations/{conversation_id}/followers",
      },
      params: {
        conversation_id: { type: "string", in: "path" },
        teammate_ids: { type: "array", items: { type: "string" } },
      },
      returns: { void: true },
      request: "teammateIdsBody",
      response: "empty",
    },
    {
      name: "create_contact",
      kind: "write",
      summary: "Create a new contact",
      endpoint: { method: "POST", path: "/contacts" },
      params: {
        name: { type: "string", optional: true },
        description: { type: "string", optional: true },
        handles: {
          type: "array",
          items: {
            type: "object",
            fields: {
              handle: { type: "string" },
              source: {
                type: "enum",
                values: [
                  "email",
                  "phone",
                  "twitter",
                  "front_chat",
                  "custom",
                  "intercom",
                  "facebook",
                  "smooch",
                ],
              },
            },
          },
          description: "At least one handle is required",
        },
        links: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
        is_spammer: { type: "boolean", optional: true },
      },
      returns: { ref: "Contact" },
      request: "createContact",
      response: "contact",
    },
    {
      name: "update_contact",
      kind: "write",
      summary: "Update an existing contact (PATCH semantics)",
      endpoint: { method: "PATCH", path: "/contacts/{contact_id}" },
      params: {
        contact_id: { type: "string", in: "path" },
        name: { type: "string", optional: true },
        description: { type: "string", optional: true },
        is_spammer: { type: "boolean", optional: true },
        links: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
      },
      returns: { void: true },
      request: "updateContact",
      response: "empty",
    },
    {
      name: "create_tag",
      kind: "write",
      summary: "Create a new company tag",
      endpoint: { method: "POST", path: "/tags" },
      params: {
        name: { type: "string" },
        highlight: {
          type: "enum",
          values: [
            "grey",
            "pink",
            "red",
            "orange",
            "yellow",
            "green",
            "light-blue",
            "blue",
            "purple",
          ],
          optional: true,
        },
        is_visible_in_conversation_lists: {
          type: "boolean",
          optional: true,
          default: true,
        },
        parent_tag_id: { type: "string", optional: true },
      },
      returns: { ref: "Tag" },
      request: "createTag",
      response: "tag",
    },
    {
      name: "update_tag",
      kind: "write",
      summary: "Update a tag (rename / recolor / re-parent)",
      endpoint: { method: "PATCH", path: "/tags/{tag_id}" },
      params: {
        tag_id: { type: "string", in: "path" },
        name: { type: "string", optional: true },
        highlight: {
          type: "enum",
          values: [
            "grey",
            "pink",
            "red",
            "orange",
            "yellow",
            "green",
            "light-blue",
            "blue",
            "purple",
          ],
          optional: true,
        },
        parent_tag_id: { type: "string", optional: true },
      },
      returns: { void: true },
      request: "updateTag",
      response: "empty",
    },
    {
      name: "delete_tag",
      kind: "write",
      summary: "Delete a tag (removes it from every conversation it was on)",
      endpoint: { method: "DELETE", path: "/tags/{tag_id}" },
      params: { tag_id: { type: "string", in: "path" } },
      returns: { void: true },
      response: "empty",
    },
  ],
};
