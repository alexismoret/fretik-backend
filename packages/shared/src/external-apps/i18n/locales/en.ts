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
        inline_images: "Inline images",
        member_count: "People",
        topic: "Topic",
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
        rule_id: "Rule ID",
        new_display_name: "New name",
        new_sequence: "New sequence",
        new_is_enabled: "New enabled",
        sequence: "Sequence",
        is_enabled: "Enabled",
        from_addresses: "From",
        subject_contains: "Subject contains",
        body_contains: "Body contains",
        has_attachments: "Has attachments",
        move_to_folder: "Move to folder",
        mark_as_read: "Mark as read",
        auto_delete: "Auto-delete",
        count: "Count",
        message_ids_preview: "Sample IDs",
        flag_status: "Flag status",
        due_date: "Due date",
        // Front-specific field labels.
        archive_after: "Archive after sending",
        tag_count: "Tags to add",
        new_status: "New status",
        scheduled_at: "Scheduled until",
        handles: "Handles",
        description: "Description",
        is_spammer: "Spam",
        tag_name: "Tag name",
        highlight: "Highlight color",
        // Shiptify-specific field labels.
        name: "Name",
        reply_before: "Reply before",
        from_count: "Pickup stops",
        dest_count: "Delivery stops",
        internal_ref: "Internal reference",
        internal_name: "Internal name",
        attachment_count: "Attachments",
        message: "Message",
        date: "Date",
        time: "Time",
        incident: "Incident",
        reason: "Reason",
        address_1: "Address",
        address_2: "Address (line 2)",
        zipcode: "Zip code",
        city: "City",
        country: "Country",
        recipient_name: "Recipient",
        instructions: "Instructions",
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
          title: { default: "Reply to email" },
        },
        reply_all_email: {
          title: { default: "Reply-all to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        create_draft: {
          title: { default: "Create draft to {{recipients}}" },
        },
        update_draft: {
          title: {
            default: "Update draft",
            withSubject: 'Update draft — "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        copy_message: {
          title: { default: "Copy email to folder" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        flag_message: {
          title: {
            flagged: "Flag email for follow-up",
            complete: "Mark email as complete",
            notFlagged: "Clear flag on email",
            default: "Update flag on email",
          },
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
          title: {
            default: "Update calendar event",
            withSubject: 'Update calendar event — "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Delete calendar event" },
        },
        respond_to_event: {
          title: {
            accept: "Accept calendar invite",
            decline: "Decline calendar invite",
            tentativelyAccept: "Tentatively accept calendar invite",
            default: "Respond to calendar invite",
          },
        },
        create_contact: {
          title: { default: 'Create contact "{{name}}"' },
        },
        create_inbox_rule: {
          title: { default: 'Create inbox rule "{{name}}"' },
        },
        update_inbox_rule: {
          title: {
            default: "Update inbox rule",
            withName: 'Update inbox rule — "{{name}}"',
          },
        },
        delete_inbox_rule: {
          title: { default: "Delete inbox rule" },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: {
            default: "Move {{count}} emails to another folder",
          },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
      },

      teams: {
        send_chat_message: {
          title: { default: "Send Teams message" },
        },
        create_chat: {
          title: {
            oneOnOne: "Start a Teams chat",
            group: "Start a Teams group chat with {{count}} people",
          },
        },
        send_channel_message: {
          title: { default: "Post in Teams channel" },
        },
        reply_to_channel_message: {
          title: { default: "Reply in Teams thread" },
        },
      },

      "imap-smtp": {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: {
            default: "Move {{count}} emails to another folder",
          },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
      },

      exchange: {
        send_email: {
          title: { default: "Send email to {{recipients}}" },
        },
        reply_email: {
          title: { default: "Reply to email" },
        },
        reply_all_email: {
          title: { default: "Reply all to email" },
        },
        forward_email: {
          title: { default: "Forward email to {{recipients}}" },
        },
        create_draft: {
          title: { default: "Create draft email" },
        },
        update_draft: {
          title: {
            default: "Update draft",
            withSubject: 'Update draft: "{{subject}}"',
          },
        },
        delete_message: {
          title: { default: "Delete email" },
        },
        move_message: {
          title: { default: "Move email to folder" },
        },
        copy_message: {
          title: { default: "Copy email to folder" },
        },
        delete_messages: {
          title: { default: "Delete {{count}} emails" },
        },
        move_messages: {
          title: { default: "Move {{count}} emails to another folder" },
        },
        mark_messages_read: {
          title: { default: "Mark {{count}} emails as read" },
        },
        mark_messages_unread: {
          title: { default: "Mark {{count}} emails as unread" },
        },
        mark_read: {
          title: { default: "Mark email as read" },
        },
        mark_unread: {
          title: { default: "Mark email as unread" },
        },
        flag_message: {
          title: {
            flagged: "Flag email for follow-up",
            complete: "Mark email as complete",
            notFlagged: "Clear email flag",
            default: "Update email flag",
          },
        },
        create_folder: {
          title: { default: 'Create mail folder "{{name}}"' },
        },
        create_calendar_event: {
          title: { default: 'Create event "{{subject}}"' },
        },
        update_calendar_event: {
          title: {
            default: "Update calendar event",
            withSubject: 'Update event "{{subject}}"',
          },
        },
        delete_calendar_event: {
          title: { default: "Delete calendar event" },
        },
        respond_to_event: {
          title: {
            accept: "Accept meeting invite",
            decline: "Decline meeting invite",
            tentativelyAccept: "Tentatively accept meeting invite",
            default: "Respond to meeting invite",
          },
        },
        create_contact: {
          title: { default: 'Create contact "{{name}}"' },
        },
      },

      shiptify: {
        create_shipment_request: {
          title: { default: 'Create shipment request "{{name}}"' },
        },
        create_shipment_request_draft: {
          title: { default: 'Create draft shipment request "{{name}}"' },
        },
        update_shipment_request: {
          title: { default: "Update shipment request" },
        },
        cancel_shipment_request: {
          title: { default: "Cancel shipment request" },
        },
        upload_shipment_request_attachment: {
          title: { default: "Upload {{count}} file(s) to shipment request" },
        },
        send_shipment_request_message: {
          title: { default: "Post message in shipment-request chat" },
        },
        confirm_shipment_pickup: {
          title: { default: "Confirm pickup on {{date}}" },
        },
        confirm_shipment_delivery: {
          title: { default: "Confirm delivery on {{date}}" },
        },
        replan_shipment_pickup: {
          title: { default: "Replan pickup to {{date}}" },
        },
        replan_shipment_delivery: {
          title: { default: "Replan delivery to {{date}}" },
        },
        upload_shipment_attachment: {
          title: { default: "Upload {{count}} file(s) to shipment" },
        },
        send_shipment_message: {
          title: { default: "Post message in shipment tracking chat" },
        },
        create_location: {
          title: { default: 'Create location "{{name}}"' },
        },
        // Galaxy (carrier-side) — same wording as the shipper variants
        // when the underlying intent matches, prefixed with "Carrier:"
        // so the user can tell the approval card apart at a glance.
        galaxy_create_carrier_shipment_request: {
          title: {
            default: 'Carrier: create shipment request "{{name}}"',
          },
        },
        galaxy_create_carrier_shipment_request_draft: {
          title: {
            default: 'Carrier: create draft shipment request "{{name}}"',
          },
        },
        galaxy_upload_shipment_request_attachment: {
          title: {
            default: "Carrier: upload {{count}} file(s) to shipment request",
          },
        },
        galaxy_send_shipment_request_message: {
          title: {
            default: "Carrier: post message in shipment-request chat",
          },
        },
        galaxy_cancel_quote_request: {
          title: { default: "Carrier: cancel quote request" },
        },
        galaxy_confirm_shipment_pickup: {
          title: { default: "Carrier: confirm pickup on {{date}}" },
        },
        galaxy_confirm_shipment_delivery: {
          title: { default: "Carrier: confirm delivery on {{date}}" },
        },
        galaxy_replan_shipment_pickup: {
          title: { default: "Carrier: replan pickup to {{date}}" },
        },
        galaxy_replan_shipment_delivery: {
          title: { default: "Carrier: replan delivery to {{date}}" },
        },
        galaxy_confirm_shipment: {
          title: { default: "Carrier: confirm shipment on {{date}}" },
        },
        galaxy_cancel_shipment: {
          title: { default: "Carrier: cancel shipment" },
        },
        galaxy_upload_shipment_attachment: {
          title: {
            default: "Carrier: upload {{count}} file(s) to shipment",
          },
        },
        galaxy_send_shipment_message: {
          title: { default: "Carrier: post message in shipment tracking chat" },
        },
        galaxy_confirm_tracking_point: {
          title: { default: "Carrier: confirm tracking point on {{date}}" },
        },
        galaxy_replan_tracking_point: {
          title: { default: "Carrier: replan tracking point to {{date}}" },
        },
        galaxy_cancel_tracking_point: {
          title: { default: "Carrier: cancel tracking point" },
        },
        galaxy_update_tracking_point_location: {
          title: { default: "Carrier: move tracking point to a new address" },
        },
      },

      front: {
        reply_to_conversation: {
          title: { default: "Reply to Front conversation" },
        },
        send_new_message: {
          title: { default: "Send new Front message to {{recipients}}" },
        },
        update_conversation: {
          title: {
            default: "Update Front conversation",
            archive: "Archive Front conversation",
            reopen: "Reopen Front conversation",
            trash: "Trash Front conversation",
            spam: "Mark Front conversation as spam",
            assign: "Assign Front conversation",
            unassign: "Unassign Front conversation",
            move: "Move Front conversation to another inbox",
          },
        },
        delete_conversation: {
          title: { default: "Delete Front conversation" },
        },
        add_conversation_tags: {
          title: { default: "Add {{count}} tag(s) to Front conversation" },
        },
        remove_conversation_tags: {
          title: {
            default: "Remove {{count}} tag(s) from Front conversation",
          },
        },
        add_conversation_comment: {
          title: { default: "Add internal note to Front conversation" },
        },
        snooze_conversation: {
          title: { default: "Snooze Front conversation until {{until}}" },
        },
        unsnooze_conversation: {
          title: { default: "Unsnooze Front conversation" },
        },
        add_conversation_followers: {
          title: {
            default: "Add {{count}} follower(s) to Front conversation",
          },
        },
        remove_conversation_followers: {
          title: {
            default: "Remove {{count}} follower(s) from Front conversation",
          },
        },
        create_contact: {
          title: {
            default: "Create Front contact",
            withName: 'Create Front contact "{{name}}"',
          },
        },
        update_contact: {
          title: { default: "Update Front contact" },
        },
        create_tag: {
          title: { default: 'Create Front tag "{{name}}"' },
        },
        update_tag: {
          title: {
            default: "Update Front tag",
            withName: 'Rename Front tag to "{{name}}"',
          },
        },
        delete_tag: {
          title: { default: "Delete Front tag" },
        },
      },
    },
  },
};
