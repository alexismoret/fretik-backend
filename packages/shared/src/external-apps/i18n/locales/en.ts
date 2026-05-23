/**
 * English translations for external-app approval summaries.
 *
 * Translation keys map 1:1 to the structural fields stored in
 * `tool_approval_requests.summary` (titleKey, titleParams, labelKey).
 *
 * Add a new language by mirroring this file as `<lang>.ts` and registering
 * it in `../index.ts`.
 */
export default {
  external_apps: {
    approvals: {
      plan: {
        title: {
          default: "Plan: {{count}} action(s)",
        },
      },

      fields: {
        to: "To",
        cc: "Cc",
        bcc: "Bcc",
        subject: "Subject",
        body: "Body",
        attachments: "Attachments",
        message_id: "Message ID",
        event_id: "Event ID",
        draft_id: "Draft ID",
        comment: "Comment",
        destination_folder: "Destination folder",
        parent_folder: "Parent folder",
        display_name: "Name",
        start: "Start",
        end: "End",
        time_zone: "Time zone",
        location: "Location",
        attendees: "Attendees",
        online_meeting: "Online meeting",
        response: "Response",
        new_subject: "New subject",
        new_body: "New body",
        new_start: "New start",
        new_end: "New end",
        new_location: "New location",
        first_name: "First name",
        last_name: "Last name",
        email: "Email",
        company: "Company",
        job_title: "Job title",
        phone: "Phone",
      },

      values: {
        yes: "Yes",
        no: "No",
      },

      outlook: {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to message {{messageId}}…" },
        },
        reply_all_email: {
          title: { default: "Reply-all to message {{messageId}}…" },
        },
        forward_email: {
          title: { default: "Forward message to {{recipients}}" },
        },
        create_draft: {
          title: { default: "Create draft to {{recipients}}" },
        },
        update_draft: {
          title: { default: "Update draft {{draftId}}…" },
        },
        delete_message: {
          title: { default: "Delete message {{messageId}}…" },
        },
        move_message: {
          title: { default: "Move message to folder {{folderId}}…" },
        },
        copy_message: {
          title: { default: "Copy message to folder {{folderId}}…" },
        },
        mark_read: {
          title: { default: "Mark message as read" },
        },
        mark_unread: {
          title: { default: "Mark message as unread" },
        },
        flag_message: {
          title: { default: "Flag message for follow-up" },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        create_calendar_event: {
          title: {
            default: 'Create event "{{subject}}" ({{start}} → {{end}})',
          },
        },
        update_calendar_event: {
          title: { default: "Update event {{eventId}}…" },
        },
        delete_calendar_event: {
          title: { default: "Delete event {{eventId}}…" },
        },
        respond_to_event: {
          title: {
            accept: "Accept event {{eventId}}…",
            decline: "Decline event {{eventId}}…",
            tentativelyAccept: "Tentatively accept event {{eventId}}…",
            default: "Respond to event {{eventId}}…",
          },
        },
        create_contact: {
          title: { default: 'Create contact "{{name}}"' },
        },
      },
    },
  },
};
