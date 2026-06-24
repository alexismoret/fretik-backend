import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Microsoft Exchange (self-hosted EWS) provider manifest.
 *
 * For teams whose mail runs on an on-prem Exchange server (HTTP Basic auth
 * over TLS, no Microsoft 365 / Graph OAuth). Transport is `custom-handler`:
 * Nango stores the credentials (private-api-basic template) but the dispatcher
 * fetches them on demand and our handlers talk EWS (SOAP) directly via
 * `ews-javascript-api`.
 *
 * Action surface mirrors Outlook (mail, calendar, contacts) adjusted to what
 * EWS supports cleanly. Inbox rules are read-only on purpose — EWS rule
 * writes go through `UpdateInboxRules(removeOutlookRuleBlob=true)`, which
 * wipes the user's Outlook-defined rules, so they are excluded.
 *
 * `message_id` / `folder_id` are the EWS `ItemId.UniqueId` / `FolderId.UniqueId`
 * — globally unique, opaque to the agent.
 */
export const exchangeManifest: ProviderManifest = {
  key: "exchange",
  displayName: "Microsoft Exchange",
  description:
    "Microsoft Exchange — read, send, and organize email; calendar events and contacts over Exchange/EWS",
  nangoProviderConfigKey: "exchange",
  icon: "i-simple-icons-microsoftexchange",
  iconColor: "#0078D4",
  transport: { kind: "custom-handler" },
  // No OAuth — Basic-auth credentials are supplied by the user via the
  // descriptor-driven form. Nango still stores them (private-api-basic).
  scopes: [],
  categories: ["communication", "email", "calendar", "contacts"],
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
          "settings.externalApps.providers.exchange.sections.account.title",
      },
      {
        // Optional overrides — auto-resolved when blank. Collapsed so the
        // default form is just email + password.
        key: "advanced",
        titleKey:
          "settings.externalApps.providers.exchange.sections.advanced.title",
        collapsed: true,
      },
    ],
    fields: [
      {
        // Email = Basic-auth login (default), Autodiscover key, and identity.
        // Stored in the Basic-Auth `username` slot via `nangoKey`.
        key: "email",
        labelKey: "settings.externalApps.providers.exchange.fields.email.label",
        helpKey: "settings.externalApps.providers.exchange.fields.email.help",
        kind: "email",
        target: "credentials",
        nangoKey: "username",
        required: true,
        section: "account",
      },
      {
        key: "password",
        labelKey:
          "settings.externalApps.providers.exchange.fields.password.label",
        kind: "password",
        target: "credentials",
        required: true,
        section: "account",
      },
      {
        // Override only when the AD sign-in differs from the email
        // (e.g. DOMAIN\\user). Blank → the email is used as the login.
        key: "login_override",
        labelKey:
          "settings.externalApps.providers.exchange.fields.login_override.label",
        helpKey:
          "settings.externalApps.providers.exchange.fields.login_override.help",
        kind: "text",
        target: "connection_config",
        required: false,
        section: "advanced",
      },
      {
        key: "ews_url",
        labelKey:
          "settings.externalApps.providers.exchange.fields.ews_url.label",
        helpKey: "settings.externalApps.providers.exchange.fields.ews_url.help",
        kind: "text",
        target: "connection_config",
        required: false,
        pattern: "^https?://",
        section: "advanced",
      },
      {
        key: "exchange_version",
        labelKey:
          "settings.externalApps.providers.exchange.fields.exchange_version.label",
        helpKey:
          "settings.externalApps.providers.exchange.fields.exchange_version.help",
        kind: "select",
        target: "connection_config",
        required: false,
        default: "auto",
        options: [
          {
            value: "auto",
            labelKey:
              "settings.externalApps.providers.exchange.fields.exchange_version.auto",
          },
          {
            value: "Exchange2010_SP2",
            labelKey:
              "settings.externalApps.providers.exchange.fields.exchange_version.v2010sp2",
          },
          {
            value: "Exchange2013",
            labelKey:
              "settings.externalApps.providers.exchange.fields.exchange_version.v2013",
          },
          {
            value: "Exchange2013_SP1",
            labelKey:
              "settings.externalApps.providers.exchange.fields.exchange_version.v2013sp1",
          },
          {
            value: "Exchange2016",
            labelKey:
              "settings.externalApps.providers.exchange.fields.exchange_version.v2016",
          },
        ],
        section: "advanced",
      },
      {
        key: "allow_self_signed_cert",
        labelKey:
          "settings.externalApps.providers.exchange.fields.allow_self_signed_cert.label",
        helpKey:
          "settings.externalApps.providers.exchange.fields.allow_self_signed_cert.help",
        kind: "boolean",
        target: "connection_config",
        required: false,
        default: false,
        section: "advanced",
      },
    ],
    testConnection: { supported: true },
  },

  // Types mirror Outlook so the agent sees a consistent shape across mail
  // providers. CalendarEvent/Contact drop the Graph-only `web_link`.
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
    CalendarEvent: {
      id: { type: "string" },
      subject: { type: "string" },
      start: { type: "datetime" },
      end: { type: "datetime" },
      location: { type: "string", optional: true },
      organizer: { type: "string", optional: true },
      attendees: { type: "array", items: { type: "email" } },
      is_online_meeting: { type: "boolean" },
      body_preview: { type: "string", optional: true },
    },
    Contact: {
      id: { type: "string" },
      display_name: { type: "string" },
      email_addresses: { type: "array", items: { type: "email" } },
      company_name: { type: "string", optional: true },
      job_title: { type: "string", optional: true },
      mobile_phone: { type: "string", optional: true },
    },
    InboxRule: {
      id: { type: "string" },
      display_name: { type: "string" },
      sequence: {
        type: "integer",
        description: "Priority order — lower runs first",
      },
      is_enabled: { type: "boolean" },
      has_error: { type: "boolean", optional: true },
    },
    WriteResult: {
      id: { type: "string", optional: true },
    },
    // Mirrors the IMAP/Outlook Attachment shape: `content_base64` is None on
    // download (the runtime spills bytes to `sandbox_path`), used on input only.
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
  },

  actions: [
    // ─────────────────────── Mail — read ───────────────────────
    {
      name: "list_messages",
      kind: "read",
      summary: "List emails from a well-known mail folder",
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
          ],
          default: "inbox",
          description: "Well-known folder name",
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
          description: "Skip the first N messages (newest-first)",
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
          description: "Message ID from list_messages / search_messages",
        },
      },
      returns: { ref: "MessageFull" },
    },
    {
      name: "search_messages",
      kind: "read",
      summary: "Search the Inbox with an Exchange AQS query",
      handler: "searchMessages",
      params: {
        query: {
          type: "string",
          description:
            "AQS query, e.g. `from:alice@example.com` (see guidance)",
        },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
      },
      returns: { list: "Message" },
    },
    {
      name: "list_messages_in_folder",
      kind: "read",
      summary: "List emails from a custom folder by its folder ID",
      handler: "listMessagesInFolder",
      params: {
        folder_id: {
          type: "string",
          description: "Folder ID returned by list_folders",
        },
        unread_only: { type: "boolean", optional: true },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
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
          description: "Message ID from list_messages / search_messages",
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

    // ─────────────────────── Calendar — read ───────────────────
    {
      name: "list_calendar_events",
      kind: "read",
      summary:
        "List calendar events in a date window (recurring series expanded)",
      handler: "listCalendarEvents",
      params: {
        start: { type: "datetime", description: "Window start (ISO 8601)" },
        end: { type: "datetime", description: "Window end (ISO 8601)" },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
      },
      returns: { list: "CalendarEvent" },
    },
    {
      name: "get_calendar_event",
      kind: "read",
      summary: "Fetch one calendar event by ID",
      handler: "getCalendarEvent",
      params: {
        event_id: { type: "string" },
      },
      returns: { ref: "CalendarEvent" },
    },

    // ─────────────────────── Contacts — read ───────────────────
    {
      name: "list_contacts",
      kind: "read",
      summary: "List contacts from the mailbox",
      handler: "listContacts",
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        offset: { type: "integer", min: 0, max: 100000, default: 0 },
      },
      returns: { list: "Contact" },
    },

    // ─────────────────────── Inbox rules — read ────────────────
    {
      name: "list_inbox_rules",
      kind: "read",
      summary: "List the inbox rules configured on the mailbox (read-only)",
      handler: "listInboxRules",
      params: {},
      returns: { list: "InboxRule" },
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
      summary: "Reply to the sender of a message",
      handler: "replyEmail",
      params: {
        message_id: { type: "string" },
        body_html: { type: "string", excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "reply_all_email",
      kind: "write",
      summary: "Reply to all recipients of a message",
      handler: "replyAllEmail",
      params: {
        message_id: { type: "string" },
        body_html: { type: "string", excludeFromHash: true },
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
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "create_draft",
      kind: "write",
      summary: "Create a draft email (not sent)",
      handler: "createDraft",
      params: {
        to: { type: "array", items: { type: "email" } },
        cc: { type: "array", items: { type: "email" }, optional: true },
        subject: { type: "string" },
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
      name: "update_draft",
      kind: "write",
      summary: "Update the subject or body of an existing draft",
      handler: "updateDraft",
      params: {
        message_id: { type: "string" },
        subject: { type: "string", optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "delete_message",
      kind: "write",
      summary: "Delete a message (moves it to Deleted Items)",
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
          description: "Destination folder ID from list_folders",
        },
      },
      returns: { ref: "WriteResult" },
    },
    {
      name: "copy_message",
      kind: "write",
      summary: "Copy a message into another folder",
      handler: "copyMessage",
      params: {
        message_id: { type: "string" },
        destination_folder_id: {
          type: "string",
          description: "Destination folder ID from list_folders",
        },
      },
      returns: { ref: "WriteResult" },
    },

    // ───── Batch write actions (one EWS round-trip via item arrays) ─────
    {
      name: "delete_messages",
      kind: "write",
      summary: "Delete multiple messages in one batch (move to Deleted Items)",
      handler: "deleteMessages",
      params: {
        message_ids: {
          type: "array",
          items: { type: "string" },
          description: "Message IDs from list_messages / search_messages",
        },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "move_messages",
      kind: "write",
      summary: "Move multiple messages to another folder in one batch",
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
      summary: "Mark multiple messages as read",
      handler: "markMessagesRead",
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "mark_messages_unread",
      kind: "write",
      summary: "Mark multiple messages as unread",
      handler: "markMessagesUnread",
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "WriteResult" },
    },
    {
      name: "mark_read",
      kind: "write",
      summary: "Mark a message as read",
      handler: "markRead",
      params: { message_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "mark_unread",
      kind: "write",
      summary: "Mark a message as unread",
      handler: "markUnread",
      params: { message_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "flag_message",
      kind: "write",
      summary:
        "Set the follow-up flag on a message (flag / mark complete / clear)",
      handler: "flagMessage",
      params: {
        message_id: { type: "string" },
        status: {
          type: "enum",
          values: ["flagged", "complete", "notFlagged"],
          default: "flagged",
          description:
            "Flag state: `flagged`=mark for follow-up, `complete`=mark done, `notFlagged`=clear. Requires Exchange 2013+.",
        },
        due_date: {
          type: "datetime",
          optional: true,
          description:
            "ISO 8601 due date for the follow-up (only meaningful when status=flagged)",
        },
      },
      returns: { ref: "WriteResult" },
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

    // ─────────────────────── Calendar — write ──────────────────
    {
      name: "create_calendar_event",
      kind: "write",
      summary: "Create a calendar event",
      handler: "createCalendarEvent",
      params: {
        subject: { type: "string" },
        start: {
          type: "datetime",
          description: "Start (ISO 8601, include a timezone offset e.g. Z)",
        },
        end: {
          type: "datetime",
          description: "End (ISO 8601, include a timezone offset e.g. Z)",
        },
        location: { type: "string", optional: true },
        attendees: { type: "array", items: { type: "email" }, optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
        is_online_meeting: { type: "boolean", optional: true },
      },
      returns: { ref: "CalendarEvent" },
    },
    {
      name: "update_calendar_event",
      kind: "write",
      summary: "Update fields of an existing calendar event",
      handler: "updateCalendarEvent",
      params: {
        event_id: { type: "string" },
        subject: { type: "string", optional: true },
        start: {
          type: "datetime",
          optional: true,
          description: "New start (ISO 8601 with timezone offset)",
        },
        end: {
          type: "datetime",
          optional: true,
          description: "New end (ISO 8601 with timezone offset)",
        },
        location: { type: "string", optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "CalendarEvent" },
    },
    {
      name: "delete_calendar_event",
      kind: "write",
      summary: "Delete a calendar event (cancels for attendees)",
      handler: "deleteCalendarEvent",
      params: { event_id: { type: "string" } },
      returns: { ref: "WriteResult" },
    },
    {
      name: "respond_to_event",
      kind: "write",
      summary: "Accept, decline or tentatively accept a meeting invite",
      handler: "respondToEvent",
      params: {
        event_id: { type: "string" },
        response: {
          type: "enum",
          values: ["accept", "decline", "tentativelyAccept"],
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
    },

    // ─────────────────────── Contacts — write ──────────────────
    {
      name: "create_contact",
      kind: "write",
      summary: "Create a new contact",
      handler: "createContact",
      params: {
        given_name: { type: "string" },
        surname: { type: "string", optional: true },
        email: { type: "email", optional: true },
        company_name: { type: "string", optional: true },
        job_title: { type: "string", optional: true },
        mobile_phone: { type: "string", optional: true },
      },
      returns: { ref: "Contact" },
    },
  ],
};
