import type { ProviderManifest } from "@fretik/shared/external-apps/manifest-schema";

/**
 * Microsoft Outlook provider manifest — 26 mature Microsoft Graph actions
 * (mail, mail folders, calendar, contacts).
 *
 * Source of truth for the generated Python SDK, the SKILL.md reference and
 * backend argument validation. Authored by hand against the Microsoft Graph
 * v1.0 reference; every endpoint is verified before merge.
 *
 * On Nango free self-hosted only Auth + Proxy are available — Nango's
 * pre-built Outlook actions (Functions tier) are NOT usable, so every
 * action below calls Microsoft Graph directly through the Nango Proxy.
 */
export const outlookManifest: ProviderManifest = {
  key: "outlook",
  displayName: "Microsoft Outlook",
  description:
    "Microsoft Outlook — read and send email, organize mail folders, and manage calendar events and contacts on the user's connected Outlook account.",
  nangoProviderConfigKey: "outlook",
  icon: "i-simple-icons-microsoftoutlook",
  iconColor: "#0078D4",
  transport: { kind: "nango-proxy" },
  // First slug ("communication") is the root used by the frontend filter.
  // The fine-grained slugs let the agent know this provider can substitute
  // for any "email", "calendar" or "contacts" request.
  categories: ["communication", "email", "calendar", "contacts"],
  // Some Outlook scopes (Calendars.Read.Shared, MailboxSettings.ReadWrite,
  // …) require tenant admin consent in many Microsoft 365 tenants. Turning
  // this on unlocks the "Install for the whole organization" toggle and the
  // friendly AADSTS error UI.
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
  scopes: [
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
    // Inbox rules (messageRules under /me/mailFolders/inbox) require
    // their own scope — `Mail.ReadWrite` does NOT cover them. End users
    // must re-consent after this is added to the Nango integration.
    "MailboxSettings.ReadWrite",
    "offline_access",
  ],

  types: {
    EmailAddress: {
      address: { type: "email" },
      name: { type: "string", optional: true },
    },
    Message: {
      id: { type: "string" },
      subject: { type: "string" },
      from_address: { type: "string", description: "Sender email address" },
      to: { type: "array", items: { type: "email" } },
      received_at: { type: "datetime" },
      is_read: { type: "boolean" },
      has_attachments: { type: "boolean" },
      body_preview: { type: "string" },
      web_link: { type: "string", optional: true },
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
      web_link: { type: "string", optional: true },
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
      web_link: { type: "string", optional: true },
    },
    Contact: {
      id: { type: "string" },
      display_name: { type: "string" },
      email_addresses: { type: "array", items: { type: "email" } },
      company_name: { type: "string", optional: true },
      job_title: { type: "string", optional: true },
      mobile_phone: { type: "string", optional: true },
    },
    WriteResult: {
      id: { type: "string", optional: true },
    },
    Calendar: {
      id: { type: "string" },
      name: { type: "string" },
      is_default_calendar: { type: "boolean" },
      can_edit: { type: "boolean" },
      color: { type: "string", optional: true },
      owner: {
        type: "string",
        optional: true,
        description:
          "Email of the calendar owner — useful for shared/secondary calendars",
      },
    },
    BatchWriteResult: {
      id: {
        type: "string",
        description:
          "Index of the request within the batch ('0'..'19') — zip with your input list to recover the original message_id",
      },
      ok: { type: "boolean" },
      error: {
        type: "string",
        optional: true,
        description: "Graph error message when ok=false",
      },
    },
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
          "Always `None` for downloaded attachments — the runtime spills the bytes to `sandbox_path` before they reach the agent. Used on input only (send/reply/forward/draft attachments).",
      },
    },
    /**
     * Inbox rule. The Microsoft Graph payload is nested
     * (`conditions.fromAddresses`, `actions.moveToFolder`, …); we flatten
     * it here so the agent only has to remember one model. Missing
     * conditions/actions are omitted (no empty arrays, no `false`
     * placeholder).
     */
    InboxRule: {
      id: { type: "string" },
      display_name: { type: "string" },
      sequence: { type: "integer" },
      is_enabled: { type: "boolean" },
      is_read_only: { type: "boolean" },
      has_error: { type: "boolean", optional: true },
      // Conditions (flat — any may be omitted).
      from_addresses: {
        type: "array",
        items: { type: "email" },
        optional: true,
        description: "Sender addresses the rule matches on",
      },
      subject_contains: {
        type: "array",
        items: { type: "string" },
        optional: true,
      },
      body_contains: {
        type: "array",
        items: { type: "string" },
        optional: true,
      },
      has_attachments: { type: "boolean", optional: true },
      // Actions (flat — any may be omitted).
      move_to_folder_id: { type: "string", optional: true },
      mark_as_read: { type: "boolean", optional: true },
      auto_delete: {
        type: "boolean",
        optional: true,
        description:
          "When true, the matching message is moved to Deleted Items",
      },
    },
  },

  actions: [
    // ───────────────────────── Mail — read ─────────────────────────
    {
      name: "list_messages",
      kind: "read",
      summary: "List emails from a well-known mail folder",
      endpoint: {
        method: "GET",
        path: "/v1.0/me/mailFolders/{folder}/messages",
      },
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
          in: "path",
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
          description: "Skip the first N results (Graph `$skip` pagination)",
        },
      },
      returns: { list: "Message" },
      request: "listMessages",
      response: "messageList",
    },
    {
      name: "get_message",
      kind: "read",
      summary: "Fetch one email by ID, with its full HTML body",
      endpoint: { method: "GET", path: "/v1.0/me/messages/{message_id}" },
      params: { message_id: { type: "string", in: "path" } },
      returns: { ref: "MessageFull" },
      response: "messageFull",
    },
    {
      name: "search_messages",
      kind: "read",
      summary: "Full-text search across the mailbox",
      endpoint: { method: "GET", path: "/v1.0/me/messages" },
      params: {
        query: { type: "string", description: "Free-text search query" },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description: "Skip the first N results (Graph `$skip` pagination)",
        },
      },
      returns: { list: "Message" },
      request: "searchMessages",
      response: "messageList",
    },
    {
      name: "list_messages_in_folder",
      kind: "read",
      summary: "List emails from a custom folder by its folder ID",
      endpoint: {
        method: "GET",
        path: "/v1.0/me/mailFolders/{folder_id}/messages",
      },
      params: {
        folder_id: { type: "string", in: "path" },
        unread_only: { type: "boolean", optional: true },
        limit: { type: "integer", min: 1, max: 100, default: 25 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description: "Skip the first N results (Graph `$skip` pagination)",
        },
      },
      returns: { list: "Message" },
      request: "listMessages",
      response: "messageList",
    },
    {
      name: "list_folders",
      kind: "read",
      summary: "List the top-level mail folders of the mailbox",
      endpoint: { method: "GET", path: "/v1.0/me/mailFolders" },
      params: {},
      returns: { list: "MailFolder" },
      response: "folderList",
    },

    // ───────────────────────── Mail — write ────────────────────────
    {
      name: "send_email",
      kind: "write",
      summary:
        "Send a new email immediately (with optional inline attachments < 3MB)",
      endpoint: { method: "POST", path: "/v1.0/me/sendMail" },
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
          description: "Inline file attachments — each item must be < 3MB",
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
      request: "sendMail",
      response: "empty",
    },
    {
      name: "reply_email",
      kind: "write",
      summary: "Reply to the sender of a message (with optional attachments)",
      endpoint: {
        method: "POST",
        path: "/v1.0/me/messages/{message_id}/reply",
      },
      params: {
        message_id: { type: "string", in: "path" },
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
      request: "replyMail",
      response: "empty",
    },
    {
      name: "reply_all_email",
      kind: "write",
      summary:
        "Reply to all recipients of a message (with optional attachments)",
      endpoint: {
        method: "POST",
        path: "/v1.0/me/messages/{message_id}/replyAll",
      },
      params: {
        message_id: { type: "string", in: "path" },
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
      request: "replyMail",
      response: "empty",
    },
    {
      name: "forward_email",
      kind: "write",
      summary:
        "Forward a message to new recipients (with optional attachments)",
      endpoint: {
        method: "POST",
        path: "/v1.0/me/messages/{message_id}/forward",
      },
      params: {
        message_id: { type: "string", in: "path" },
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
      request: "forwardMail",
      response: "empty",
    },
    {
      name: "create_draft",
      kind: "write",
      summary: "Create a draft email (not sent), with optional attachments",
      endpoint: { method: "POST", path: "/v1.0/me/messages" },
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
      request: "createDraft",
      response: "writeResult",
    },
    {
      name: "update_draft",
      kind: "write",
      summary: "Update the subject or body of an existing draft",
      endpoint: { method: "PATCH", path: "/v1.0/me/messages/{message_id}" },
      params: {
        message_id: { type: "string", in: "path" },
        subject: { type: "string", optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
      },
      returns: { ref: "WriteResult" },
      request: "updateDraft",
      response: "writeResult",
    },
    {
      name: "delete_message",
      kind: "write",
      summary: "Delete a message (moves it to Deleted Items)",
      endpoint: { method: "DELETE", path: "/v1.0/me/messages/{message_id}" },
      params: { message_id: { type: "string", in: "path" } },
      returns: { void: true },
      response: "empty",
    },
    {
      name: "move_message",
      kind: "write",
      summary: "Move a message to another mail folder",
      endpoint: { method: "POST", path: "/v1.0/me/messages/{message_id}/move" },
      params: {
        message_id: { type: "string", in: "path" },
        destination_folder_id: { type: "string" },
      },
      returns: { ref: "WriteResult" },
      request: "moveCopyMessage",
      response: "writeResult",
    },
    {
      name: "copy_message",
      kind: "write",
      summary: "Copy a message into another mail folder",
      endpoint: { method: "POST", path: "/v1.0/me/messages/{message_id}/copy" },
      params: {
        message_id: { type: "string", in: "path" },
        destination_folder_id: { type: "string" },
      },
      returns: { ref: "WriteResult" },
      request: "moveCopyMessage",
      response: "writeResult",
    },

    // ───── Batch write actions (Graph `$batch`, cap 20 / call) ─────
    // Each variant emits one POST to /v1.0/$batch with up to 20 nested
    // requests. For larger sets the agent chunks in Python — every
    // batch gets its own approval card with a count summary.
    {
      name: "delete_messages",
      kind: "write",
      summary: "Delete up to 20 messages in a single Graph $batch request",
      endpoint: { method: "POST", path: "/v1.0/$batch" },
      params: {
        message_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "1–20 message IDs. For larger sets, call this action multiple times.",
        },
      },
      returns: { list: "BatchWriteResult" },
      request: "deleteMessagesBatch",
      response: "batchWriteResponse",
    },
    {
      name: "move_messages",
      kind: "write",
      summary:
        "Move up to 20 messages to a folder in a single Graph $batch request",
      endpoint: { method: "POST", path: "/v1.0/$batch" },
      params: {
        message_ids: { type: "array", items: { type: "string" } },
        destination_folder_id: { type: "string" },
      },
      returns: { list: "BatchWriteResult" },
      request: "moveMessagesBatch",
      response: "batchWriteResponse",
    },
    {
      name: "mark_messages_read",
      kind: "write",
      summary:
        "Mark up to 20 messages as read in a single Graph $batch request",
      endpoint: { method: "POST", path: "/v1.0/$batch" },
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "BatchWriteResult" },
      request: "markMessagesReadBatch",
      response: "batchWriteResponse",
    },
    {
      name: "mark_messages_unread",
      kind: "write",
      summary:
        "Mark up to 20 messages as unread in a single Graph $batch request",
      endpoint: { method: "POST", path: "/v1.0/$batch" },
      params: {
        message_ids: { type: "array", items: { type: "string" } },
      },
      returns: { list: "BatchWriteResult" },
      request: "markMessagesUnreadBatch",
      response: "batchWriteResponse",
    },
    {
      name: "mark_read",
      kind: "write",
      summary: "Mark a message as read",
      endpoint: { method: "PATCH", path: "/v1.0/me/messages/{message_id}" },
      params: { message_id: { type: "string", in: "path" } },
      returns: { void: true },
      request: "markRead",
      response: "empty",
    },
    {
      name: "mark_unread",
      kind: "write",
      summary: "Mark a message as unread",
      endpoint: { method: "PATCH", path: "/v1.0/me/messages/{message_id}" },
      params: { message_id: { type: "string", in: "path" } },
      returns: { void: true },
      request: "markUnread",
      response: "empty",
    },
    {
      name: "flag_message",
      kind: "write",
      summary:
        "Set the follow-up flag on a message (flag / mark complete / clear)",
      endpoint: { method: "PATCH", path: "/v1.0/me/messages/{message_id}" },
      params: {
        message_id: { type: "string", in: "path" },
        status: {
          type: "enum",
          values: ["flagged", "notFlagged", "complete"],
          default: "flagged",
          description:
            "Flag state: `flagged`=mark for follow-up, `complete`=mark done (checked), `notFlagged`=clear the flag",
        },
        due_date: {
          type: "datetime",
          optional: true,
          description:
            "ISO 8601 due date for the follow-up reminder (only meaningful when status=flagged)",
        },
        time_zone: {
          type: "string",
          optional: true,
          default: "UTC",
          description: "Time zone for `due_date`",
        },
      },
      returns: { void: true },
      request: "flagMessage",
      response: "empty",
    },
    {
      name: "create_folder",
      kind: "write",
      summary: "Create a new mail folder",
      endpoint: { method: "POST", path: "/v1.0/me/mailFolders" },
      params: {
        display_name: { type: "string" },
        parent_folder_id: {
          type: "string",
          optional: true,
          description: "Parent folder ID (top-level if omitted)",
        },
      },
      returns: { ref: "MailFolder" },
      request: "createFolder",
      response: "folder",
    },

    // ─────────────────── Mail attachments — read ───────────────────
    {
      name: "list_message_attachments",
      kind: "read",
      summary: "List attachments on a message (metadata only — no content)",
      endpoint: {
        method: "GET",
        path: "/v1.0/me/messages/{message_id}/attachments",
      },
      params: { message_id: { type: "string", in: "path" } },
      returns: { list: "Attachment" },
      request: "listMessageAttachments",
      response: "attachmentList",
    },
    {
      name: "download_message_attachment",
      kind: "read",
      summary: "Download one attachment in base64 (file attachments only)",
      endpoint: {
        method: "GET",
        path: "/v1.0/me/messages/{message_id}/attachments/{attachment_id}",
      },
      params: {
        message_id: { type: "string", in: "path" },
        attachment_id: { type: "string", in: "path" },
      },
      returns: { ref: "Attachment" },
      response: "attachmentContent",
    },

    // ─────────────────────── Calendar ───────────────────────
    {
      name: "list_calendars",
      kind: "read",
      summary:
        "List every calendar the user can access (default, shared, secondary)",
      endpoint: { method: "GET", path: "/v1.0/me/calendars" },
      params: {},
      returns: { list: "Calendar" },
      response: "calendarList",
    },
    {
      name: "list_calendar_events",
      kind: "read",
      summary: "List calendar events within a date window",
      // Manifest path is the default (primary calendar). When the
      // agent passes `calendar_id`, the request mapper overrides the
      // endpoint to `/v1.0/me/calendars/{calendar_id}/calendarView`.
      endpoint: { method: "GET", path: "/v1.0/me/calendarView" },
      params: {
        start: { type: "datetime", description: "Window start (ISO 8601)" },
        end: { type: "datetime", description: "Window end (ISO 8601)" },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description: "Skip the first N events (Graph `$skip` pagination)",
        },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { list: "CalendarEvent" },
      request: "listCalendarEvents",
      response: "eventList",
    },
    {
      name: "get_calendar_event",
      kind: "read",
      summary: "Fetch one calendar event by ID",
      endpoint: { method: "GET", path: "/v1.0/me/events/{event_id}" },
      params: {
        event_id: { type: "string", in: "path" },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { ref: "CalendarEvent" },
      request: "getCalendarEvent",
      response: "event",
    },
    {
      name: "list_event_instances",
      kind: "read",
      summary:
        "List the individual occurrences of a recurring event in a date window",
      // Manifest path is the master series default; mapper overrides
      // when calendar_id is set (same convention as the other calendar
      // actions).
      endpoint: {
        method: "GET",
        path: "/v1.0/me/events/{event_id}/instances",
      },
      params: {
        event_id: {
          type: "string",
          in: "path",
          description: "Master recurring series event ID",
        },
        start: { type: "datetime", description: "Window start (ISO 8601)" },
        end: { type: "datetime", description: "Window end (ISO 8601)" },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description: "Skip the first N instances (Graph `$skip` pagination)",
        },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { list: "CalendarEvent" },
      request: "listEventInstances",
      response: "eventList",
    },
    {
      name: "create_calendar_event",
      kind: "write",
      summary: "Create a calendar event",
      endpoint: { method: "POST", path: "/v1.0/me/events" },
      params: {
        subject: { type: "string" },
        start: { type: "datetime" },
        end: { type: "datetime" },
        time_zone: { type: "string", optional: true, default: "UTC" },
        location: { type: "string", optional: true },
        attendees: { type: "array", items: { type: "email" }, optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
        is_online_meeting: { type: "boolean", optional: true },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { ref: "CalendarEvent" },
      request: "createEvent",
      response: "event",
    },
    {
      name: "update_calendar_event",
      kind: "write",
      summary: "Update fields of an existing calendar event",
      endpoint: { method: "PATCH", path: "/v1.0/me/events/{event_id}" },
      params: {
        event_id: { type: "string", in: "path" },
        subject: { type: "string", optional: true },
        start: { type: "datetime", optional: true },
        end: { type: "datetime", optional: true },
        time_zone: { type: "string", optional: true, default: "UTC" },
        location: { type: "string", optional: true },
        body_html: { type: "string", optional: true, excludeFromHash: true },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { ref: "CalendarEvent" },
      request: "updateEvent",
      response: "event",
    },
    {
      name: "delete_calendar_event",
      kind: "write",
      summary: "Delete a calendar event",
      endpoint: { method: "DELETE", path: "/v1.0/me/events/{event_id}" },
      params: {
        event_id: { type: "string", in: "path" },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { void: true },
      request: "deleteCalendarEvent",
      response: "empty",
    },
    {
      name: "respond_to_event",
      kind: "write",
      summary: "Accept, decline or tentatively accept a meeting invite",
      endpoint: {
        method: "POST",
        path: "/v1.0/me/events/{event_id}/{response}",
      },
      params: {
        event_id: { type: "string", in: "path" },
        response: {
          type: "enum",
          values: ["accept", "decline", "tentativelyAccept"],
          in: "path",
        },
        comment: { type: "string", optional: true, excludeFromHash: true },
        calendar_id: {
          type: "string",
          optional: true,
          description:
            "Calendar ID from list_calendars(). Defaults to the primary calendar.",
        },
      },
      returns: { void: true },
      request: "respondToEvent",
      response: "empty",
    },

    // ─────────────────────── Contacts ───────────────────────
    {
      name: "list_contacts",
      kind: "read",
      summary: "List contacts from the mailbox",
      endpoint: { method: "GET", path: "/v1.0/me/contacts" },
      params: {
        limit: { type: "integer", min: 1, max: 100, default: 50 },
        offset: {
          type: "integer",
          min: 0,
          max: 100000,
          default: 0,
          description: "Skip the first N contacts (Graph `$skip` pagination)",
        },
      },
      returns: { list: "Contact" },
      request: "listContacts",
      response: "contactList",
    },
    {
      name: "create_contact",
      kind: "write",
      summary: "Create a new contact",
      endpoint: { method: "POST", path: "/v1.0/me/contacts" },
      params: {
        given_name: { type: "string" },
        surname: { type: "string", optional: true },
        email: { type: "email", optional: true },
        company_name: { type: "string", optional: true },
        job_title: { type: "string", optional: true },
        mobile_phone: { type: "string", optional: true },
      },
      returns: { ref: "Contact" },
      request: "createContact",
      response: "contact",
    },

    // ─────────────────── Inbox rules (messageRules) ────────────────────
    // Server-side mail rules applied on incoming messages. Conditions
    // and actions are kept flat in the SDK (`from_addresses`,
    // `move_to_folder_id`, …) — see InboxRule type for the full set.
    // Requires the `MailboxSettings.ReadWrite` scope.
    {
      name: "list_inbox_rules",
      kind: "read",
      summary: "List the inbox rules configured on the mailbox",
      endpoint: {
        method: "GET",
        path: "/v1.0/me/mailFolders/inbox/messageRules",
      },
      params: {},
      returns: { list: "InboxRule" },
      response: "ruleList",
    },
    {
      name: "create_inbox_rule",
      kind: "write",
      summary:
        "Create an inbox rule (e.g. move incoming mail from a sender to a folder)",
      endpoint: {
        method: "POST",
        path: "/v1.0/me/mailFolders/inbox/messageRules",
      },
      params: {
        display_name: { type: "string" },
        sequence: {
          type: "integer",
          optional: true,
          default: 1,
          description: "Priority order — lower runs first",
        },
        is_enabled: { type: "boolean", optional: true, default: true },
        // Conditions — at least one is strongly recommended (a rule with
        // no conditions matches every message).
        from_addresses: {
          type: "array",
          items: { type: "email" },
          optional: true,
        },
        subject_contains: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
        body_contains: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
        has_attachments: { type: "boolean", optional: true },
        // Actions — at least one MUST be set or Microsoft Graph rejects
        // the rule with HTTP 400.
        move_to_folder_id: { type: "string", optional: true },
        mark_as_read: { type: "boolean", optional: true },
        auto_delete: {
          type: "boolean",
          optional: true,
          description:
            "When true, the matching message is moved to Deleted Items",
        },
      },
      returns: { ref: "InboxRule" },
      request: "createInboxRule",
      response: "rule",
    },
    {
      name: "update_inbox_rule",
      kind: "write",
      summary:
        "Update an existing inbox rule (PATCH semantics, all fields optional)",
      endpoint: {
        method: "PATCH",
        path: "/v1.0/me/mailFolders/inbox/messageRules/{rule_id}",
      },
      params: {
        rule_id: { type: "string", in: "path" },
        display_name: { type: "string", optional: true },
        sequence: { type: "integer", optional: true },
        is_enabled: { type: "boolean", optional: true },
        from_addresses: {
          type: "array",
          items: { type: "email" },
          optional: true,
        },
        subject_contains: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
        body_contains: {
          type: "array",
          items: { type: "string" },
          optional: true,
        },
        has_attachments: { type: "boolean", optional: true },
        move_to_folder_id: { type: "string", optional: true },
        mark_as_read: { type: "boolean", optional: true },
        auto_delete: { type: "boolean", optional: true },
      },
      returns: { ref: "InboxRule" },
      request: "updateInboxRule",
      response: "rule",
    },
    {
      name: "delete_inbox_rule",
      kind: "write",
      summary: "Delete an inbox rule",
      endpoint: {
        method: "DELETE",
        path: "/v1.0/me/mailFolders/inbox/messageRules/{rule_id}",
      },
      params: { rule_id: { type: "string", in: "path" } },
      returns: { void: true },
      response: "empty",
    },
  ],
};
