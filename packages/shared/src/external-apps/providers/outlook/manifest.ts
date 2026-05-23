import type { ProviderManifest } from "../../manifest-schema";

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
  nangoProviderConfigKey: "outlook",
  icon: "i-simple-icons-microsoftoutlook",
  scopes: [
    "Mail.ReadWrite",
    "Mail.Send",
    "Calendars.ReadWrite",
    "Contacts.ReadWrite",
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
    Attachment: {
      id: { type: "string" },
      name: { type: "string" },
      content_type: { type: "string" },
      size_bytes: { type: "integer" },
      content_base64: {
        type: "string",
        optional: true,
        description:
          "Base64-encoded content (set on download, omitted on list)",
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
      summary: "Flag a message for follow-up",
      endpoint: { method: "PATCH", path: "/v1.0/me/messages/{message_id}" },
      params: { message_id: { type: "string", in: "path" } },
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
      name: "list_calendar_events",
      kind: "read",
      summary: "List calendar events within a date window",
      endpoint: { method: "GET", path: "/v1.0/me/calendarView" },
      params: {
        start: { type: "datetime", description: "Window start (ISO 8601)" },
        end: { type: "datetime", description: "Window end (ISO 8601)" },
        limit: { type: "integer", min: 1, max: 100, default: 50 },
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
      params: { event_id: { type: "string", in: "path" } },
      returns: { ref: "CalendarEvent" },
      response: "event",
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
      params: { event_id: { type: "string", in: "path" } },
      returns: { void: true },
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
      params: { limit: { type: "integer", min: 1, max: 100, default: 50 } },
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
  ],
};
