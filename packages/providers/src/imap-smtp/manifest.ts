import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * IMAP/SMTP provider manifest — generic mail access over the open
 * standards (RFC 3501 IMAP4rev1 + RFC 5321 SMTP). Covers any mailbox the
 * user can reach with a username/password: Exchange (self-hosted +
 * hosted), Gmail (with an App Password), Yahoo, Fastmail, OVH, custom
 * servers, …
 *
 * Transport is `custom-handler` — Nango stores credentials (via the
 * `private-api-basic` template) but the dispatcher fetches them on demand
 * and invokes our own TS handlers, which talk IMAP/SMTP directly.
 *
 * Message IDs are opaque composite strings (`<base64url(folder)>.<uid>`),
 * built by the handlers. The agent never inspects them.
 */
export const imapSmtpManifest: ProviderManifest = {
  key: "imap-smtp",
  displayName: "Email (IMAP/SMTP)",
  description:
    "Email over IMAP/SMTP — read, search, and send email on the user's connected mailbox for any standards-based provider (Gmail app password, OVH, Fastmail, custom servers, …).",
  nangoProviderConfigKey: "imap-smtp",
  icon: "i-lucide-mail",
  transport: { kind: "custom-handler" },
  // No OAuth — Basic Auth credentials are supplied by the user via the
  // descriptor-driven form. Nango still stores them (private-api-basic
  // template).
  scopes: [],
  categories: ["communication", "email"],
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

  credentialsForm: {
    sections: [
      {
        key: "account",
        titleKey:
          "settings.externalApps.providers.imap-smtp.sections.account.title",
      },
      {
        key: "imap",
        titleKey:
          "settings.externalApps.providers.imap-smtp.sections.imap.title",
      },
      {
        key: "smtp",
        titleKey:
          "settings.externalApps.providers.imap-smtp.sections.smtp.title",
      },
    ],
    fields: [
      {
        key: "username",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.username.label",
        helpKey:
          "settings.externalApps.providers.imap-smtp.fields.username.help",
        kind: "email",
        target: "credentials",
        required: true,
        section: "account",
      },
      {
        key: "password",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.password.label",
        helpKey:
          "settings.externalApps.providers.imap-smtp.fields.password.help",
        kind: "password",
        target: "credentials",
        required: true,
        section: "account",
      },
      {
        key: "imap_host",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.imap_host.label",
        kind: "text",
        target: "connection_config",
        required: true,
        section: "imap",
      },
      {
        key: "imap_port",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.imap_port.label",
        kind: "number",
        target: "connection_config",
        required: true,
        default: 993,
        min: 1,
        max: 65535,
        section: "imap",
      },
      {
        key: "imap_secure",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.imap_secure.label",
        kind: "select",
        target: "connection_config",
        required: true,
        default: "tls",
        options: [
          {
            value: "tls",
            labelKey:
              "settings.externalApps.providers.imap-smtp.fields.secure.tls",
          },
          {
            value: "starttls",
            labelKey:
              "settings.externalApps.providers.imap-smtp.fields.secure.starttls",
          },
        ],
        section: "imap",
      },
      {
        key: "smtp_host",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.smtp_host.label",
        kind: "text",
        target: "connection_config",
        required: true,
        section: "smtp",
      },
      {
        key: "smtp_port",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.smtp_port.label",
        kind: "number",
        target: "connection_config",
        required: true,
        default: 465,
        min: 1,
        max: 65535,
        section: "smtp",
      },
      {
        key: "smtp_secure",
        labelKey:
          "settings.externalApps.providers.imap-smtp.fields.smtp_secure.label",
        kind: "select",
        target: "connection_config",
        required: true,
        default: "tls",
        options: [
          {
            value: "tls",
            labelKey:
              "settings.externalApps.providers.imap-smtp.fields.secure.tls",
          },
          {
            value: "starttls",
            labelKey:
              "settings.externalApps.providers.imap-smtp.fields.secure.starttls",
          },
        ],
        section: "smtp",
      },
    ],
    testConnection: { supported: true },
  },

  // Types deliberately mirror Outlook so the agent sees a consistent
  // Message / MessageFull / MailFolder shape regardless of provider.
  types: {
    Message: {
      id: { type: "string" },
      subject: { type: "string" },
      from_address: { type: "string", description: "Sender email address" },
      to: { type: "array", items: { type: "email" } },
      received_at: { type: "datetime" },
      is_read: { type: "boolean" },
      has_attachments: { type: "boolean" },
      body_preview: { type: "string" },
    },
    MessageFull: {
      id: { type: "string" },
      subject: { type: "string" },
      from_address: { type: "string" },
      to: { type: "array", items: { type: "email" } },
      cc: { type: "array", items: { type: "email" } },
      received_at: { type: "datetime" },
      is_read: { type: "boolean" },
      has_attachments: { type: "boolean" },
      body_html: { type: "string" },
    },
    MailFolder: {
      id: { type: "string" },
      display_name: { type: "string" },
      parent_folder_id: { type: "string", optional: true },
      total_item_count: { type: "integer" },
      unread_item_count: { type: "integer" },
    },
    // Shape mirrors Outlook's Attachment so the agent treats every mail
    // provider uniformly. `content_base64` is always `None` on download
    // — the runtime spills the binary to `sandbox_path` before the value
    // reaches the agent (see `_runtime.py:_spill_attachments`).
    Attachment: {
      id: { type: "string" },
      name: { type: "string" },
      content_type: { type: "string" },
      size_bytes: { type: "integer" },
      sandbox_path: {
        type: "string",
        optional: true,
        description:
          "On-disk path to the downloaded binary inside the sandbox. The runtime spills the file here so the agent never sees the raw base64 — use it with any file-consuming tool or library (vision, python libs like pypdf/pillow/pandas, bash commands, etc.).",
      },
      content_base64: {
        type: "string",
        optional: true,
        description:
          "Always `None` on download (the runtime spills bytes to `sandbox_path`). Used on input only (send/reply/forward attachments).",
      },
    },
    WriteResult: {
      id: { type: "string", optional: true },
    },
  },

  actions: [
    // ─────────────────────── Mail — read ───────────────────────
    {
      name: "list_messages",
      kind: "read",
      summary:
        "List emails from a well-known mail folder, newest received_at first",
      handler: "listMessages",
      params: {
        folder: {
          type: "enum",
          values: [
            "inbox",
            "sentitems",
            "drafts",
            "deleteditems",
            "archive",
            "junkemail",
            "flagged",
            "important",
            "allmail",
          ],
          default: "inbox",
          description:
            "Well-known folder (RFC 6154 SPECIAL-USE + Gmail's \\Important extension)",
        },
        unread_only: {
          type: "boolean",
          optional: true,
          description: "Only return unread messages",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description:
            "Skip the first N messages (paginate the sorted UID list, newest-first)",
        },
      },
      returns: { list: "Message" },
    },
    {
      name: "get_message",
      kind: "read",
      summary: "Fetch one email by ID, with its full HTML body",
      handler: "getMessage",
      params: {
        message_id: {
          type: "string",
          description: "Opaque message ID from list_messages / search_messages",
        },
      },
      returns: { ref: "MessageFull" },
    },
    {
      name: "search_messages",
      kind: "read",
      summary: "Full-text search across the INBOX, newest received_at first",
      handler: "searchMessages",
      params: {
        query: {
          type: "string",
          optional: true,
          description:
            "Free-text search query. IMAP SEARCH does NOT parse the 'OR' keyword — use `query_or` for alternatives instead.",
        },
        query_or: {
          type: "array",
          items: { type: "string" },
          optional: true,
          description:
            "Match messages where TEXT matches ANY of these terms (native IMAP OR). Use INSTEAD of writing 'a OR b' in `query`. Exactly one of `query` or `query_or` is required.",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description:
            "Skip the first N matches (paginate the sorted UID list, newest-first)",
        },
      },
      returns: { list: "Message" },
    },
    {
      name: "list_messages_in_folder",
      kind: "read",
      summary:
        "List emails from a custom folder by its folder ID, newest received_at first",
      handler: "listMessagesInFolder",
      params: {
        folder_id: {
          type: "string",
          description: "Folder ID returned by list_folders",
        },
        unread_only: { type: "boolean", optional: true },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description:
            "Skip the first N messages (paginate the sorted UID list, newest-first)",
        },
      },
      returns: { list: "Message" },
    },
    {
      name: "list_folders",
      kind: "read",
      summary: "List every mail folder of the mailbox",
      handler: "listFolders",
      params: {},
      returns: { list: "MailFolder" },
    },

    // ──────────────────── Attachments — read ───────────────────
    {
      name: "list_message_attachments",
      kind: "read",
      summary: "List attachments on a message (metadata only — no content)",
      handler: "listMessageAttachments",
      params: {
        message_id: {
          type: "string",
          description: "Opaque message ID from list_messages / search_messages",
        },
      },
      returns: { list: "Attachment" },
    },
    {
      name: "download_message_attachment",
      kind: "read",
      summary: "Download one attachment — binary is spilled to `sandbox_path`",
      handler: "downloadMessageAttachment",
      params: {
        message_id: { type: "string" },
        attachment_id: {
          type: "string",
          description: "Attachment ID from list_message_attachments",
        },
      },
      returns: { ref: "Attachment" },
    },

    // ─────────────────────── Mail — write ──────────────────────
    {
      name: "send_email",
      kind: "write",
      summary: "Send a new email immediately (with optional attachments)",
      handler: "sendEmail",
      params: {
        to: { type: "array", items: { type: "email" } },
        cc: { type: "array", items: { type: "email" }, optional: true },
        bcc: { type: "array", items: { type: "email" }, optional: true },
        subject: { type: "string" },
        body_html: {
          type: "string",
          excludeFromHash: true,
          description: "HTML body",
        },
        attachments: {
          type: "array",
          optional: true,
          excludeFromHash: true,
          description: "File attachments (base64-encoded)",
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
    },
    {
      name: "reply_email",
      kind: "write",
      summary:
        "Reply to the sender of a message (preserves In-Reply-To threading)",
      handler: "replyEmail",
      params: {
        message_id: { type: "string" },
        body_html: { type: "string", excludeFromHash: true },
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
    },
    {
      name: "forward_email",
      kind: "write",
      summary: "Forward a message to new recipients (with optional comment)",
      handler: "forwardEmail",
      params: {
        message_id: { type: "string" },
        to: { type: "array", items: { type: "email" } },
        comment: { type: "string", optional: true, excludeFromHash: true },
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
    },
    {
      name: "mark_read",
      kind: "write",
      summary: "Mark a message as read (sets the \\Seen flag)",
      handler: "markRead",
      params: { message_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "mark_unread",
      kind: "write",
      summary: "Mark a message as unread (clears the \\Seen flag)",
      handler: "markUnread",
      params: { message_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "delete_message",
      kind: "write",
      summary: "Move a message to Trash (or expunge if no Trash folder exists)",
      handler: "deleteMessage",
      params: { message_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "move_message",
      kind: "write",
      summary: "Move a message to another folder",
      handler: "moveMessage",
      params: {
        message_id: { type: "string" },
        destination_folder_id: {
          type: "string",
          description:
            "Destination folder ID from list_folders (or a folder path)",
        },
      },
      returns: { ref: "WriteResult" },
    },

    // ───── Batch write actions (1 IMAP round-trip per source folder) ─────
    // Prefer these for >5 messages: a single IMAP STORE/MOVE on a UID
    // array instead of N separate connections. The approval card shows
    // one row with a count instead of N separate rows.
    {
      name: "delete_messages",
      kind: "write",
      summary:
        "Delete multiple messages in a single IMAP batch (move to Trash, or expunge if no Trash exists)",
      handler: "deleteMessages",
      params: {
        message_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Opaque message IDs from list_messages / search_messages. Mixed-folder IDs are grouped server-side — one IMAP command per source folder.",
        },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "move_messages",
      kind: "write",
      summary:
        "Move multiple messages to another folder in a single IMAP batch",
      handler: "moveMessages",
      params: {
        message_ids: { type: "array", items: { type: "string" } },
        destination_folder_id: {
          type: "string",
          description: "Destination folder ID from list_folders",
        },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "mark_messages_read",
      kind: "write",
      summary:
        "Mark multiple messages as read (single IMAP STORE per source folder)",
      handler: "markMessagesRead",
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "mark_messages_unread",
      kind: "write",
      summary:
        "Mark multiple messages as unread (single IMAP STORE per source folder)",
      handler: "markMessagesUnread",
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "create_folder",
      kind: "write",
      summary: "Create a new mail folder",
      handler: "createFolder",
      params: {
        display_name: { type: "string", description: "Folder name to create" },
        parent_folder_id: {
          type: "string",
          optional: true,
          description: "Parent folder ID (omit to create at the root)",
        },
      },
      returns: { ref: "MailFolder" },
    },
  ],
};
